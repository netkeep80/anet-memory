#!/usr/bin/env python3
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from two_store_cutover import *

SCRIPT=str(Path(__file__).with_name('two_store_cutover.py'))
SCOPE='scope-a'; OLD='writer-old'; NEW='writer-new'
OLD_SECRET='22'*32; NEW_SECRET='33'*32; CONTROL='11'*32; ATTEST='44'*32


def cli(op, *, source=None, sink=None, obj=None, sig=None, cert=None, source_sig=None, failpoint=None):
    cmd=[sys.executable,SCRIPT,op]
    if source: cmd += ['--source',str(source)]
    if sink: cmd += ['--sink',str(sink)]
    if obj is not None: cmd += ['--json',json.dumps(obj,separators=(',',':'))]
    if sig: cmd += ['--sig',sig]
    if cert is not None: cmd += ['--cert',json.dumps(cert,separators=(',',':'))]
    if source_sig: cmd += ['--source-sig',source_sig]
    if failpoint: cmd += ['--failpoint',failpoint]
    return subprocess.run(cmd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)

class TwoStoreCutoverTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='anet-two-store-'); self.addCleanup(self.tmp.cleanup)
        self.source=Path(self.tmp.name)/'source.sqlite'; self.sink=Path(self.tmp.name)/'sink.sqlite'
        init_source(self.source,ATTEST); init_sink(self.sink,SCOPE,OLD,OLD_SECRET,NEW,NEW_SECRET,CONTROL,ATTEST)

    def intent(self,key,payload=b'x'):
        r=enqueue(self.source,key,payload); return r

    def old_request(self,key,payload_sha,request=None):
        c=writer_claim(SCOPE,1,OLD,request or f'old-{key}',key,payload_sha); return c,mac(OLD_SECRET,c)

    def new_request(self,key,payload_sha,request=None):
        c=writer_claim(SCOPE,2,NEW,request or f'new-{key}',key,payload_sha); return c,mac(NEW_SECRET,c)

    def freeze(self,request='freeze-1'):
        c=freeze_claim(SCOPE,request); return c,mac(CONTROL,c)

    def activate(self,rec,request='activate-1'):
        c=activation_claim(SCOPE,request,rec['digest'],rec['certificate']['freeze_hash'])
        return c,mac(CONTROL,c)

    def full_to_reconcile(self, applied=True):
        i=self.intent('e1',b'a')
        c,s=self.old_request('e1',i['payload_sha256'])
        if applied: sink_apply(self.sink,c,s)
        fence_source(self.source)
        f,fs=self.freeze(); freeze_sink(self.sink,f,fs)
        return i,c,s,reconcile(self.source,self.sink)

    def test_ack_lost_before_cut_is_classified_applied_and_not_duplicated(self):
        i=self.intent('e1',b'a'); c,s=self.old_request('e1',i['payload_sha256']); sink_apply(self.sink,c,s)
        fence_source(self.source); f,fs=self.freeze(); freeze_sink(self.sink,f,fs)
        rec=reconcile(self.source,self.sink)
        self.assertEqual(rec['certificate']['applied_keys'],['e1']); self.assertEqual(rec['certificate']['pending_keys'],[])
        a,asig=self.activate(rec); activate_sink(self.sink,a,asig,rec['certificate'],rec['signature']); mark_promoted(self.source,self.sink,rec['digest'])
        nc,ns=self.new_request('e1',i['payload_sha256'])
        self.assertEqual(sink_apply(self.sink,nc,ns)['state'],'ALREADY_APPLIED')
        self.assertEqual(sink_state(self.sink)['effect_count'],1)

    def test_inflight_old_request_after_freeze_is_rejected_then_pending_replayed_by_successor(self):
        i=self.intent('e1',b'a'); old,olds=self.old_request('e1',i['payload_sha256'])
        fence_source(self.source); f,fs=self.freeze(); freeze_sink(self.sink,f,fs)
        with self.assertRaisesRegex(ProtocolError,'SINK_FROZEN'): sink_apply(self.sink,old,olds)
        rec=reconcile(self.source,self.sink); self.assertEqual(rec['certificate']['pending_keys'],['e1'])
        a,asig=self.activate(rec); activate_sink(self.sink,a,asig,rec['certificate'],rec['signature']); mark_promoted(self.source,self.sink,rec['digest'])
        new,news=self.new_request('e1',i['payload_sha256']); self.assertEqual(sink_apply(self.sink,new,news)['state'],'APPLIED')
        with self.assertRaisesRegex(ProtocolError,'STALE_AUTHORITY'): sink_apply(self.sink,old,olds)

    def test_successor_is_effect_ineligible_until_reconciliation_activation(self):
        i=self.intent('e1'); fence_source(self.source); f,fs=self.freeze(); freeze_sink(self.sink,f,fs)
        c,s=self.new_request('e1',i['payload_sha256'])
        with self.assertRaisesRegex(ProtocolError,'SINK_FROZEN'): sink_apply(self.sink,c,s)

    def test_source_promotion_requires_durable_sink_activation_receipt(self):
        _,_,_,rec=self.full_to_reconcile(applied=False)
        with self.assertRaisesRegex(ProtocolError,'SINK_SUCCESSOR_NOT_ACTIVE'):
            mark_promoted(self.source,self.sink,rec['digest'])
        a,asig=self.activate(rec)
        activated=activate_sink(self.sink,a,asig,rec['certificate'],rec['signature'])
        promoted=mark_promoted(self.source,self.sink,rec['digest'])
        self.assertEqual(promoted['activation_hash'],activated['activation_hash'])
        self.assertEqual(promoted['activation_seq'],activated['activation_seq'])

    def test_source_cannot_create_new_intent_after_fence(self):
        fence_source(self.source)
        with self.assertRaisesRegex(ProtocolError,'SOURCE_FENCED'): enqueue(self.source,'late',b'x')

    def test_untracked_sink_effect_fails_reconciliation(self):
        c=writer_claim(SCOPE,1,OLD,'rogue-r','rogue',sha(b'rogue')); sink_apply(self.sink,c,mac(OLD_SECRET,c))
        fence_source(self.source); f,fs=self.freeze(); freeze_sink(self.sink,f,fs)
        with self.assertRaisesRegex(ProtocolError,'UNTRACKED_SINK_EFFECT'): reconcile(self.source,self.sink)

    def test_payload_mismatch_fails_reconciliation(self):
        i=self.intent('e1',b'a'); c=writer_claim(SCOPE,1,OLD,'wrong','e1',sha(b'b')); sink_apply(self.sink,c,mac(OLD_SECRET,c))
        fence_source(self.source); f,fs=self.freeze(); freeze_sink(self.sink,f,fs)
        with self.assertRaisesRegex(ProtocolError,'SINK_PAYLOAD_MISMATCH'): reconcile(self.source,self.sink)

    def test_tampered_source_terminal_chain_fails_reconciliation(self):
        self.intent('e1',b'a'); fence_source(self.source); f,fs=self.freeze(); freeze_sink(self.sink,f,fs)
        with db(self.source) as con:
            con.execute("UPDATE intents SET payload_sha256=? WHERE seq=1",('f'*64,))
        with self.assertRaisesRegex(ProtocolError,'SOURCE_CHAIN_HASH_MISMATCH|SOURCE_TERMINAL_DIVERGED'):
            reconcile(self.source,self.sink)

    def test_tampered_frozen_sink_receipt_index_fails_reconciliation(self):
        i=self.intent('e1',b'a'); c,sig=self.old_request('e1',i['payload_sha256']); sink_apply(self.sink,c,sig)
        fence_source(self.source); f,fs=self.freeze(); freeze_sink(self.sink,f,fs)
        with db(self.sink) as con:
            con.execute("UPDATE sink_effects SET payload_sha256=? WHERE effect_key='e1'",('f'*64,))
        with self.assertRaisesRegex(ProtocolError,'SINK_RECEIPT_INDEX_MISMATCH'):
            reconcile(self.source,self.sink)

    def test_tampered_reconciliation_certificate_cannot_activate(self):
        _,_,_,rec=self.full_to_reconcile(applied=False)
        a,asig=self.activate(rec); bad=dict(rec['certificate']); bad['pending_keys']=[]
        with self.assertRaisesRegex(ProtocolError,'SOURCE_ATTEST_FAILED|CERTIFICATE_BINDING_MISMATCH'): activate_sink(self.sink,a,asig,bad,rec['signature'])

    def test_activation_requires_exact_freeze_barrier(self):
        _,_,_,rec=self.full_to_reconcile(applied=False)
        a=activation_claim(SCOPE,'activate-x',rec['digest'],'f'*64)
        with self.assertRaisesRegex(ProtocolError,'CERTIFICATE_BINDING_MISMATCH'): activate_sink(self.sink,a,mac(CONTROL,a),rec['certificate'],rec['signature'])

    def test_reconcile_retry_is_idempotent(self):
        _,_,_,r1=self.full_to_reconcile(applied=False); r2=reconcile(self.source,self.sink)
        self.assertEqual(r2['state'],'ALREADY_RECONCILED'); self.assertEqual(r1['digest'],r2['digest'])

    def test_source_fence_lost_ack_is_idempotent(self):
        self.intent('e1'); p=cli('fence-source',source=self.source,failpoint='after-commit-before-ack'); self.assertNotEqual(p.returncode,0)
        self.assertEqual(source_state(self.source)['phase'],'SOURCE_FENCED'); self.assertEqual(fence_source(self.source)['state'],'SOURCE_ALREADY_FENCED')

    def test_sink_freeze_lost_ack_is_idempotent_and_blocks_old_writer(self):
        i=self.intent('e1'); fence_source(self.source); f,fs=self.freeze()
        p=cli('freeze-sink',sink=self.sink,obj=f,sig=fs,failpoint='after-commit-before-ack'); self.assertNotEqual(p.returncode,0)
        self.assertEqual(sink_state(self.sink)['phase'],'FROZEN'); self.assertEqual(freeze_sink(self.sink,f,fs)['state'],'SINK_ALREADY_FROZEN')
        c,s=self.old_request('e1',i['payload_sha256']);
        with self.assertRaisesRegex(ProtocolError,'SINK_FROZEN'): sink_apply(self.sink,c,s)

    def test_activation_lost_ack_is_idempotent(self):
        _,_,_,rec=self.full_to_reconcile(applied=False); a,asig=self.activate(rec)
        p=cli('activate-sink',sink=self.sink,obj=a,sig=asig,cert=rec['certificate'],source_sig=rec['signature'],failpoint='after-commit-before-ack'); self.assertNotEqual(p.returncode,0)
        self.assertEqual(sink_state(self.sink)['generation'],2)
        self.assertEqual(activate_sink(self.sink,a,asig,rec['certificate'],rec['signature'])['state'],'SUCCESSOR_ALREADY_ACTIVE')

    def test_parallel_old_apply_vs_freeze_is_always_reconcilable(self):
        for n in range(8):
            source=Path(self.tmp.name)/f's-{n}.sqlite'; sink=Path(self.tmp.name)/f'k-{n}.sqlite'
            init_source(source,ATTEST); init_sink(sink,SCOPE,OLD,OLD_SECRET,NEW,NEW_SECRET,CONTROL,ATTEST)
            i=enqueue(source,'e1',b'a'); fence_source(source)
            old=writer_claim(SCOPE,1,OLD,f'old-{n}','e1',i['payload_sha256']); osig=mac(OLD_SECRET,old)
            fr=freeze_claim(SCOPE,f'freeze-{n}'); fsig=mac(CONTROL,fr)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
                fa=ex.submit(lambda: _capture(lambda: sink_apply(sink,old,osig)))
                ff=ex.submit(lambda: _capture(lambda: freeze_sink(sink,fr,fsig)))
                ar,rr=fa.result(),ff.result()
            self.assertTrue(rr[0],rr)
            rec=reconcile(source,sink)
            if ar[0]: self.assertEqual(rec['certificate']['applied_keys'],['e1'])
            else:
                self.assertIn('SINK_FROZEN',ar[1]); self.assertEqual(rec['certificate']['pending_keys'],['e1'])

    def test_no_external_effect_permission(self):
        self.assertFalse(sink_state(self.sink)['external_effects_allowed'])


def _capture(fn):
    try: return True,fn()
    except Exception as exc: return False,str(exc)

if __name__=='__main__': unittest.main()
