#!/usr/bin/env python3
import concurrent.futures
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from authenticated_effect_sink import init, install, rotate, apply, sign, state, SinkError

SCRIPT=str(Path(__file__).with_name('authenticated_effect_sink.py'))
SCOPE='research'
C1='1'*40; C2='2'*40
K1='11'*32; K2='22'*32

class AuthenticatedEffectCutoverTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='anet-auth-effect-'); self.addCleanup(self.tmp.cleanup)
        self.db=Path(self.tmp.name)/'sink.sqlite'; init(self.db); install(self.db,SCOPE,1,C1,K1)

    def sig(self,key,payload=b'x',gen=1,commit=C1,secret=K1):
        return sign(secret,SCOPE,gen,commit,key,payload)

    def test_authenticated_generation1_apply(self):
        self.assertEqual(apply(self.db,SCOPE,1,C1,'k',b'x',self.sig('k'))['state'],'APPLIED')
        self.assertEqual(state(self.db,SCOPE)['counter'],1)

    def test_forged_writer_rejected(self):
        with self.assertRaisesRegex(SinkError,'UNAUTHENTICATED_WRITER'):
            apply(self.db,SCOPE,1,C1,'k',b'x','0'*64)
        self.assertEqual(state(self.db,SCOPE)['counter'],0)

    def test_stale_signed_request_delivered_after_rotation_rejected(self):
        stale=self.sig('late')
        rotate(self.db,SCOPE,1,C1,2,C2,K2)
        with self.assertRaisesRegex(SinkError,'UNAUTHENTICATED_WRITER|STALE_AUTHORITY'):
            apply(self.db,SCOPE,1,C1,'late',b'x',stale)
        self.assertEqual(state(self.db,SCOPE)['counter'],0)

    def test_new_generation_requires_new_credential(self):
        rotate(self.db,SCOPE,1,C1,2,C2,K2)
        bad=sign(K1,SCOPE,2,C2,'new',b'x')
        with self.assertRaisesRegex(SinkError,'UNAUTHENTICATED_WRITER'):
            apply(self.db,SCOPE,2,C2,'new',b'x',bad)
        good=sign(K2,SCOPE,2,C2,'new',b'x')
        self.assertEqual(apply(self.db,SCOPE,2,C2,'new',b'x',good)['state'],'APPLIED')

    def test_idempotent_retry_same_generation(self):
        s=self.sig('k')
        self.assertEqual(apply(self.db,SCOPE,1,C1,'k',b'x',s)['state'],'APPLIED')
        self.assertEqual(apply(self.db,SCOPE,1,C1,'k',b'x',s)['state'],'ALREADY_APPLIED')
        self.assertEqual(state(self.db,SCOPE)['counter'],1)

    def test_same_key_cannot_be_reapplied_after_rotation(self):
        s=self.sig('k'); apply(self.db,SCOPE,1,C1,'k',b'x',s)
        rotate(self.db,SCOPE,1,C1,2,C2,K2)
        s2=sign(K2,SCOPE,2,C2,'k',b'x')
        with self.assertRaisesRegex(SinkError,'IDEMPOTENCY_KEY_CONFLICT'):
            apply(self.db,SCOPE,2,C2,'k',b'x',s2)
        self.assertEqual(state(self.db,SCOPE)['counter'],1)

    def test_rotation_cas_rejects_stale_controller(self):
        rotate(self.db,SCOPE,1,C1,2,C2,K2)
        with self.assertRaisesRegex(SinkError,'AUTHORITY_CAS_MISMATCH'):
            rotate(self.db,SCOPE,1,C1,2,'3'*40,'33'*32)

    def test_race_apply_vs_rotate_has_only_two_safe_outcomes(self):
        def do_apply():
            try: return ('apply',apply(self.db,SCOPE,1,C1,'race',b'x',self.sig('race'))['state'])
            except SinkError as e: return ('apply','REFUSED:'+str(e))
        def do_rotate():
            try: return ('rotate',rotate(self.db,SCOPE,1,C1,2,C2,K2)['state'])
            except SinkError as e: return ('rotate','REFUSED:'+str(e))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
            results=dict(ex.map(lambda f:f(),[do_apply,do_rotate]))
        self.assertEqual(results['rotate'],'AUTHORITY_ROTATED')
        self.assertIn(results['apply'],('APPLIED','REFUSED:UNAUTHENTICATED_WRITER','REFUSED:STALE_AUTHORITY'))
        st=state(self.db,SCOPE)
        self.assertEqual(st['authority']['generation'],2)
        if results['apply']=='APPLIED': self.assertEqual(st['counter'],1)
        else: self.assertEqual(st['counter'],0)

    def test_many_real_process_races_preserve_linearization(self):
        for i in range(8):
            db=Path(self.tmp.name)/f'race-{i}.sqlite'; init(db); install(db,SCOPE,1,C1,K1)
            sig=sign(K1,SCOPE,1,C1,'race',b'x')
            apply_cmd=[sys.executable,SCRIPT,'apply','--db',str(db),'--scope',SCOPE,'--generation','1','--commit',C1,'--effect-key','race','--payload','x','--signature',sig]
            rot_cmd=[sys.executable,SCRIPT,'rotate','--db',str(db),'--scope',SCOPE,'--expected-generation','1','--expected-commit',C1,'--new-generation','2','--new-commit',C2,'--new-secret',K2]
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
                pa,pr=list(ex.map(lambda cmd: subprocess.run(cmd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20),[apply_cmd,rot_cmd]))
            self.assertEqual(pr.returncode,0,pr.stderr)
            self.assertIn(pa.returncode,(0,2),pa.stderr)
            st=state(db,SCOPE); self.assertEqual(st['authority']['generation'],2)
            self.assertIn(st['counter'],(0,1))
            if st['counter']==0: self.assertEqual(pa.returncode,2)

    def test_sigkill_before_apply_commit_rolls_back(self):
        sig=self.sig('kill')
        p=subprocess.run([sys.executable,SCRIPT,'apply','--db',str(self.db),'--scope',SCOPE,'--generation','1','--commit',C1,'--effect-key','kill','--payload','x','--signature',sig,'--failpoint','before-commit'],timeout=20)
        self.assertNotEqual(p.returncode,0); self.assertEqual(state(self.db,SCOPE)['counter'],0)
        self.assertEqual(apply(self.db,SCOPE,1,C1,'kill',b'x',sig)['state'],'APPLIED')

    def test_sigkill_after_apply_commit_before_ack_dedups(self):
        sig=self.sig('kill')
        p=subprocess.run([sys.executable,SCRIPT,'apply','--db',str(self.db),'--scope',SCOPE,'--generation','1','--commit',C1,'--effect-key','kill','--payload','x','--signature',sig,'--failpoint','after-commit-before-ack'],timeout=20)
        self.assertNotEqual(p.returncode,0); self.assertEqual(state(self.db,SCOPE)['counter'],1)
        self.assertEqual(apply(self.db,SCOPE,1,C1,'kill',b'x',sig)['state'],'ALREADY_APPLIED')

    def test_sigkill_before_rotation_commit_leaves_old_authority_active(self):
        p=subprocess.run([sys.executable,SCRIPT,'rotate','--db',str(self.db),'--scope',SCOPE,'--expected-generation','1','--expected-commit',C1,'--new-generation','2','--new-commit',C2,'--new-secret',K2,'--failpoint','before-commit'],timeout=20)
        self.assertNotEqual(p.returncode,0); self.assertEqual(state(self.db,SCOPE)['authority']['generation'],1)
        self.assertEqual(apply(self.db,SCOPE,1,C1,'still-old',b'x',self.sig('still-old'))['state'],'APPLIED')

    def test_sigkill_after_rotation_commit_fences_old_retry(self):
        stale=self.sig('late')
        p=subprocess.run([sys.executable,SCRIPT,'rotate','--db',str(self.db),'--scope',SCOPE,'--expected-generation','1','--expected-commit',C1,'--new-generation','2','--new-commit',C2,'--new-secret',K2,'--failpoint','after-commit-before-ack'],timeout=20)
        self.assertNotEqual(p.returncode,0); self.assertEqual(state(self.db,SCOPE)['authority']['generation'],2)
        with self.assertRaisesRegex(SinkError,'UNAUTHENTICATED_WRITER|STALE_AUTHORITY'):
            apply(self.db,SCOPE,1,C1,'late',b'x',stale)

if __name__=='__main__': unittest.main()
