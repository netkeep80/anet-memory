#!/usr/bin/env python3
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from fenced_effect_sink import (SinkError, apply, apply_claim, init, ledger, rotate, rotation_claim, sign_apply, sign_rotation, state)

SCRIPT=str(Path(__file__).with_name('fenced_effect_sink.py'))
SCOPE='scope-a'
CONTROL='11'*32
OLD_SECRET='22'*32
NEW_SECRET='33'*32
OLD='writer-old'
NEW='writer-new'


def run_cli(db, op, claim, sig, failpoint=None):
    cmd=[sys.executable,SCRIPT,op,'--db',str(db),'--claim',json.dumps(claim,separators=(',',':')),'--signature',sig]
    if failpoint: cmd += ['--failpoint',failpoint]
    return subprocess.run(cmd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)

class FencedEffectSinkTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='anet-fenced-sink-'); self.addCleanup(self.tmp.cleanup)
        self.db=Path(self.tmp.name)/'sink.sqlite'
        init(self.db,SCOPE,CONTROL,OLD,OLD_SECRET,NEW,NEW_SECRET)

    def old_claim(self,key='e1',request='old-r1',payload=b'old'):
        c=apply_claim(SCOPE,1,OLD,request,key,payload); return c,sign_apply(OLD_SECRET,c)

    def new_claim(self,key='e2',request='new-r1',payload=b'new'):
        c=apply_claim(SCOPE,2,NEW,request,key,payload); return c,sign_apply(NEW_SECRET,c)

    def rotation(self,request='rot-1'):
        c=rotation_claim(SCOPE,1,OLD,2,NEW,request); return c,sign_rotation(CONTROL,c)

    def test_authenticated_old_apply_before_rotation_is_in_ledger_before_cut(self):
        c,s=self.old_claim(); a=apply(self.db,c,s)
        r,rs=self.rotation(); cut=rotate(self.db,r,rs)
        rows=ledger(self.db,SCOPE)
        self.assertEqual([x['kind'] for x in rows],['EFFECT_APPLIED','AUTHORITY_ROTATED'])
        self.assertLess(a['receipt_seq'],cut['receipt_seq'])

    def test_rotation_before_inflight_old_apply_rejects_at_sink(self):
        c,s=self.old_claim()
        r,rs=self.rotation(); rotate(self.db,r,rs)
        with self.assertRaisesRegex(SinkError,'STALE_AUTHORITY'): apply(self.db,c,s)
        self.assertEqual(state(self.db,SCOPE)['effect_count'],0)

    def test_new_writer_cannot_apply_before_rotation(self):
        c,s=self.new_claim()
        with self.assertRaisesRegex(SinkError,'STALE_AUTHORITY'): apply(self.db,c,s)

    def test_new_writer_applies_after_rotation(self):
        r,rs=self.rotation(); rotate(self.db,r,rs)
        c,s=self.new_claim(); self.assertEqual(apply(self.db,c,s)['state'],'APPLIED')
        self.assertEqual(state(self.db,SCOPE)['effect_count'],1)

    def test_writer_forgery_and_wrong_secret_are_rejected(self):
        c,_=self.old_claim()
        with self.assertRaisesRegex(SinkError,'AUTH_FAILED'): apply(self.db,c,sign_apply(NEW_SECRET,c))
        forged=apply_claim(SCOPE,2,NEW,'forged','e9',b'x')
        with self.assertRaisesRegex(SinkError,'AUTH_FAILED'): apply(self.db,forged,sign_apply(OLD_SECRET,forged))

    def test_writer_cannot_forge_control_rotation(self):
        r,_=self.rotation()
        with self.assertRaisesRegex(SinkError,'CONTROL_AUTH_FAILED'): rotate(self.db,r,sign_rotation(OLD_SECRET,r))

    def test_apply_retry_after_lost_ack_is_deduplicated(self):
        c,s=self.old_claim()
        p=run_cli(self.db,'apply',c,s,'after-commit-before-ack'); self.assertNotEqual(p.returncode,0)
        retry=apply(self.db,c,s)
        self.assertEqual(retry['state'],'ALREADY_APPLIED')
        self.assertEqual(state(self.db,SCOPE)['effect_count'],1)

    def test_apply_kill_before_commit_rolls_back(self):
        c,s=self.old_claim()
        p=run_cli(self.db,'apply',c,s,'before-commit'); self.assertNotEqual(p.returncode,0)
        self.assertEqual(state(self.db,SCOPE)['effect_count'],0)
        self.assertEqual(apply(self.db,c,s)['state'],'APPLIED')

    def test_rotation_retry_after_lost_ack_is_idempotent(self):
        r,s=self.rotation()
        p=run_cli(self.db,'rotate',r,s,'after-commit-before-ack'); self.assertNotEqual(p.returncode,0)
        retry=rotate(self.db,r,s)
        self.assertEqual(retry['state'],'AUTHORITY_ALREADY_INSTALLED')
        self.assertEqual(state(self.db,SCOPE)['authority']['generation'],2)

    def test_rotation_kill_before_commit_leaves_old_authority(self):
        r,s=self.rotation()
        p=run_cli(self.db,'rotate',r,s,'before-commit'); self.assertNotEqual(p.returncode,0)
        self.assertEqual(state(self.db,SCOPE)['authority']['generation'],1)
        c,cs=self.old_claim(); self.assertEqual(apply(self.db,c,cs)['state'],'APPLIED')

    def test_idempotency_key_conflict_is_fail_closed(self):
        c,s=self.old_claim(key='same',request='r1',payload=b'a'); apply(self.db,c,s)
        c2,s2=self.old_claim(key='same',request='r2',payload=b'b')
        with self.assertRaisesRegex(SinkError,'IDEMPOTENCY_KEY_CONFLICT'): apply(self.db,c2,s2)

    def test_actual_parallel_OS_race_old_apply_vs_rotation_linearizes(self):
        # Repeat independent databases so scheduler ordering can vary; every result
        # must be either old effect before the rotation or stale rejection after it.
        outcomes=set()
        for i in range(12):
            db=Path(self.tmp.name)/f'race-{i}.sqlite'
            init(db,SCOPE,CONTROL,OLD,OLD_SECRET,NEW,NEW_SECRET)
            c,s=(apply_claim(SCOPE,1,OLD,f'old-{i}',f'e-{i}',b'x'),None); s=sign_apply(OLD_SECRET,c)
            r,rs=(rotation_claim(SCOPE,1,OLD,2,NEW,f'rot-{i}'),None); rs=sign_rotation(CONTROL,r)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
                fa=ex.submit(run_cli,db,'apply',c,s); fr=ex.submit(run_cli,db,'rotate',r,rs)
                pa,pr=fa.result(),fr.result()
            self.assertEqual(pr.returncode,0,(pr.stdout,pr.stderr))
            rows=ledger(db,SCOPE)
            if pa.returncode==0:
                outcomes.add('APPLIED_BEFORE_ROTATE')
                self.assertEqual([x['kind'] for x in rows],['EFFECT_APPLIED','AUTHORITY_ROTATED'])
            else:
                outcomes.add('REJECTED_AFTER_ROTATE')
                self.assertIn('STALE_AUTHORITY',pa.stderr)
                self.assertEqual([x['kind'] for x in rows],['AUTHORITY_ROTATED'])
            self.assertEqual(state(db,SCOPE)['authority']['generation'],2)
        self.assertTrue(outcomes <= {'APPLIED_BEFORE_ROTATE','REJECTED_AFTER_ROTATE'})

    def test_no_external_effect_claim(self):
        self.assertFalse(state(self.db,SCOPE)['external_effects_allowed'])

if __name__=='__main__': unittest.main()
