#!/usr/bin/env python3
import json
import unittest
from selector_contract import *

H64='a'*64
C40='1'*40
SCOPE='anet-memory/commit-boundary/main'

def selector(gen=1, prev=None, **kw):
    return make_selector(scope=SCOPE,generation=gen,previous_selector_sha256=prev,
        source_terminal_seq=kw.get('source_terminal_seq',7),source_terminal_head=kw.get('source_terminal_head',H64),
        sink_freeze_seq=kw.get('sink_freeze_seq',9),sink_freeze_hash=kw.get('sink_freeze_hash','b'*64),
        sink_terminal_effect_seq=kw.get('sink_terminal_effect_seq',8),sink_terminal_effect_head=kw.get('sink_terminal_effect_head','c'*64),
        reconcile_digest=kw.get('reconcile_digest','d'*64),evidence_commit_sha=kw.get('evidence_commit_sha',C40))

class SelectorContractTests(unittest.TestCase):
    def test_tag_is_deterministic_and_generation_scoped(self):
        t=canonical_tag(SCOPE,1)
        self.assertEqual(t,canonical_tag(SCOPE,1)); self.assertNotEqual(t,canonical_tag(SCOPE,2))
        self.assertRegex(t,r'^anet-cutover/v1/[0-9a-f]{64}/g00000000000000000001$')

    def test_canonical_bytes_are_stable(self):
        s=selector(); self.assertEqual(selector_bytes(s),selector_bytes(json.loads(selector_bytes(s))))

    def test_root_requires_no_predecessor(self):
        with self.assertRaisesRegex(SelectorError,'ROOT_MUST_NOT_HAVE_PREDECESSOR'):
            selector(1,'f'*64)

    def test_nonroot_requires_predecessor(self):
        with self.assertRaisesRegex(SelectorError,'PREDECESSOR_REQUIRED'):
            selector(2,None)

    def test_valid_transition_binds_exact_previous_bytes(self):
        a=selector_bytes(selector())
        b=selector_bytes(selector(2,sha256_bytes(a)))
        self.assertEqual(verify_transition(a,b)['state'],'CHAIN_OK')

    def test_transition_rejects_gap(self):
        a=selector_bytes(selector())
        b=selector_bytes(selector(3,sha256_bytes(a)))
        with self.assertRaisesRegex(SelectorError,'NON_CONTIGUOUS_GENERATION'):
            verify_transition(a,b)

    def test_transition_rejects_wrong_predecessor(self):
        a=selector_bytes(selector())
        b=selector_bytes(selector(2,'e'*64))
        with self.assertRaisesRegex(SelectorError,'PREDECESSOR_MISMATCH'):
            verify_transition(a,b)

    def test_platform_contract_positive_fixture(self):
        raw=selector_bytes(selector())
        obs={"immutable":True,"tag_name":canonical_tag(SCOPE,1),"attested_commit_sha":C40,
             "asset_name":"selector.json","asset_digest":"sha256:"+sha256_bytes(raw),
             "release_verified":True,"asset_verified":True}
        self.assertEqual(verify_platform_observation(raw,obs)['state'],'PLATFORM_OBSERVATION_CONTRACT_OK')

    def test_mutable_release_rejected(self):
        raw=selector_bytes(selector()); obs={"immutable":False,"tag_name":canonical_tag(SCOPE,1),"attested_commit_sha":C40,
          "asset_name":"selector.json","asset_digest":"sha256:"+sha256_bytes(raw),"release_verified":True,"asset_verified":True}
        with self.assertRaisesRegex(SelectorError,'RELEASE_NOT_IMMUTABLE'): verify_platform_observation(raw,obs)

    def test_wrong_tag_rejected_even_if_attested(self):
        raw=selector_bytes(selector()); obs={"immutable":True,"tag_name":"other","attested_commit_sha":C40,
          "asset_name":"selector.json","asset_digest":"sha256:"+sha256_bytes(raw),"release_verified":True,"asset_verified":True}
        with self.assertRaisesRegex(SelectorError,'TAG_MISMATCH'): verify_platform_observation(raw,obs)

    def test_wrong_asset_digest_rejected(self):
        raw=selector_bytes(selector()); obs={"immutable":True,"tag_name":canonical_tag(SCOPE,1),"attested_commit_sha":C40,
          "asset_name":"selector.json","asset_digest":"sha256:"+'0'*64,"release_verified":True,"asset_verified":True}
        with self.assertRaisesRegex(SelectorError,'ASSET_DIGEST_MISMATCH'): verify_platform_observation(raw,obs)

    def test_release_notes_are_not_selector_authority(self):
        raw=selector_bytes(selector())
        # Contract intentionally accepts no title/body/latest fields at all.
        obs={"immutable":True,"tag_name":canonical_tag(SCOPE,1),"attested_commit_sha":C40,
          "asset_name":"selector.json","asset_digest":"sha256:"+sha256_bytes(raw),"release_verified":True,"asset_verified":True,"title":"editable"}
        with self.assertRaisesRegex(SelectorError,'OBSERVATION_KEYS_MISMATCH'): verify_platform_observation(raw,obs)

    def test_unverified_attestation_or_asset_rejected(self):
        raw=selector_bytes(selector()); base={"immutable":True,"tag_name":canonical_tag(SCOPE,1),"attested_commit_sha":C40,
          "asset_name":"selector.json","asset_digest":"sha256:"+sha256_bytes(raw),"release_verified":True,"asset_verified":True}
        for field,err in (("release_verified","RELEASE_ATTESTATION_NOT_VERIFIED"),("asset_verified","ASSET_NOT_VERIFIED")):
            obs=dict(base); obs[field]=False
            with self.assertRaisesRegex(SelectorError,err): verify_platform_observation(raw,obs)

if __name__=='__main__': unittest.main()
