#!/usr/bin/env python3
"""Adversarial local SQLite cutover interleavings; no application effects."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from cutover_race import (
    CutoverError, bootstrap, catchup, checkpoint, fence, init, promote,
    record, state, connect, rows, sha, canonical,
)

SCRIPT = str(Path(__file__).with_name('cutover_race.py'))


def command(db, op, *extra):
    return subprocess.run([sys.executable, SCRIPT, op, '--db', str(db), *extra],
                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)


class CutoverRaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='anet-cutover-race-')
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.source, self.follower = root/'authority.sqlite', root/'passive.sqlite'
        init(self.source)

    def prepare(self):
        record(self.source,1,'before-checkpoint','before')
        cp = checkpoint(self.source)
        bootstrap(self.source,self.follower)
        return cp

    def test_late_write_before_fence_must_be_in_terminal_head(self):
        cp=self.prepare()
        late=record(self.source,1,'late-before-fence','late')
        cut=fence(self.source)
        self.assertEqual(cut['terminal_sequence'],cp['sequence']+1)
        self.assertEqual(cut['terminal_head'],late['entry_hash'])
        with self.assertRaisesRegex(CutoverError,'CATCHUP_REQUIRED'):
            promote(self.source,self.follower)
        replay=catchup(self.source,self.follower)
        self.assertEqual(replay['sequence'],cut['terminal_sequence'])
        self.assertEqual(promote(self.source,self.follower)['generation'],2)
        with self.assertRaisesRegex(CutoverError,'WRITER_FENCED'):
            record(self.source,1,'old-after-promotion','blocked')
        self.assertEqual(record(self.source,2,'successor','new')['state'],'RECORDED')
        self.assertEqual(state(self.source)['actual_sequence'],cut['terminal_sequence']+1)

    def test_fence_before_late_write_must_refuse_old_writer(self):
        cp=self.prepare()
        cut=fence(self.source)
        self.assertEqual(cut['terminal_sequence'],cp['sequence'])
        with self.assertRaisesRegex(CutoverError,'WRITER_FENCED'):
            record(self.source,1,'late-after-fence','blocked')
        self.assertEqual(catchup(self.source,self.follower)['sequence'],cp['sequence'])
        self.assertEqual(promote(self.source,self.follower)['state'],'SUCCESSOR_PROMOTED')

    def test_catchup_retry_dedup_and_competing_promote_rejected(self):
        self.prepare()
        record(self.source,1,'late','payload')
        fence(self.source)
        self.assertEqual(catchup(self.source,self.follower)['state'],'CATCHUP_COMPLETE')
        self.assertEqual(catchup(self.source,self.follower)['state'],'ALREADY_CAUGHT_UP')
        promote(self.source,self.follower)
        with self.assertRaisesRegex(CutoverError,'PROMOTION_NOT_ALLOWED'):
            promote(self.source,self.follower)

    def test_missing_checkpoint_and_out_of_order_transition_rejected(self):
        with self.assertRaisesRegex(CutoverError,'FENCE_NOT_ALLOWED'):
            fence(self.source)
        with self.assertRaisesRegex(CutoverError,'CUT_NOT_COMMITTED'):
            catchup(self.source,self.follower)
        self.prepare()
        with self.assertRaisesRegex(CutoverError,'CHECKPOINT_NOT_ALLOWED'):
            checkpoint(self.source)
        with self.assertRaisesRegex(CutoverError,'PROMOTION_NOT_ALLOWED'):
            promote(self.source,self.follower)

    def test_follower_corruption_rejected(self):
        self.prepare()
        record(self.source,1,'late','payload')
        fence(self.source)
        with connect(self.follower) as con:
            con.execute("UPDATE cut_events SET payload_sha256=? WHERE sequence=1",('f'*64,))
        with self.assertRaisesRegex(CutoverError,'FOLLOWER_STALE_OR_DIVERGED'):
            catchup(self.source,self.follower)

    def test_missing_or_altered_terminal_journal_rejected(self):
        self.prepare()
        record(self.source,1,'late','payload')
        fence(self.source)
        with connect(self.source) as con:
            con.execute("UPDATE cut_events SET payload_sha256=? WHERE sequence=2",('f'*64,))
        with self.assertRaisesRegex(CutoverError,'JOURNAL_HASH_MISMATCH'):
            catchup(self.source,self.follower)

    def test_no_follower_can_promote_without_replay(self):
        self.prepare()
        record(self.source,1,'late','payload')
        fence(self.source)
        with self.assertRaisesRegex(CutoverError,'CATCHUP_REQUIRED'):
            promote(self.source,self.follower)
        self.assertEqual(state(self.source)['generation'],1)

    def test_generation2_cannot_write_before_promotion(self):
        self.prepare()
        with self.assertRaisesRegex(CutoverError,'WRITER_FENCED'):
            record(self.source,2,'premature','blocked')
        fence(self.source)
        with self.assertRaisesRegex(CutoverError,'WRITER_FENCED'):
            record(self.source,2,'premature','blocked')

    def test_real_subprocess_fence_sigkill_before_commit_rolls_back(self):
        self.prepare()
        p=command(self.source,'fence','--failpoint','before-commit')
        self.assertNotEqual(p.returncode,0)
        self.assertEqual(state(self.source)['phase'],'ACTIVE')
        record(self.source,1,'late-after-rollback','must-be-included')
        cut=fence(self.source)
        self.assertEqual(cut['terminal_sequence'],2)
        catchup(self.source,self.follower)
        promote(self.source,self.follower)

    def test_real_subprocess_fence_sigkill_after_commit_before_ack(self):
        self.prepare()
        p=command(self.source,'fence','--failpoint','after-commit-before-ack')
        self.assertNotEqual(p.returncode,0)
        self.assertEqual(state(self.source)['phase'],'CUT_COMMITTED')
        with self.assertRaisesRegex(CutoverError,'WRITER_FENCED'):
            record(self.source,1,'old-after-unknown-ack','blocked')
        with self.assertRaisesRegex(CutoverError,'FENCE_NOT_ALLOWED'):
            fence(self.source)
        catchup(self.source,self.follower)
        promote(self.source,self.follower)

    def test_caller_generation_is_not_authentication_negative_falsifier(self):
        # Anyone with write access to the local DB can claim an active generation.
        # No writer credential is authenticated by this research harness.
        first=record(self.source,1,'forged-writer-claim','synthetic')
        self.assertEqual(first['state'],'RECORDED')
        self.prepare()
        fence(self.source)
        catchup(self.source,self.follower)
        promote(self.source,self.follower)
        fake_successor=record(self.source,2,'forged-successor-claim','synthetic')
        self.assertEqual(fake_successor['state'],'RECORDED')

    def test_actual_parallel_OS_writer_vs_fence_has_no_lost_committed_event(self):
        # Repeated real process races, not a proof of SQLite across sandboxes.
        for i in range(8):
            with self.subTest(race=i):
                root=Path(self.tmp.name)
                source=root/f'race-{i}.sqlite'
                follower=root/f'follow-{i}.sqlite'
                init(source)
                record(source,1,'initial','before')
                checkpoint(source)
                bootstrap(source,follower)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    old=pool.submit(command,source,'record','--generation','1','--key',f'late-{i}','--payload',f'late-{i}')
                    seal=pool.submit(command,source,'fence')
                    a,b=old.result(),seal.result()
                self.assertEqual(b.returncode,0,b.stderr+b.stdout)
                writer=json.loads(a.stdout)
                terminal=state(source)['terminal_seq']
                if writer['state']=='RECORDED':
                    self.assertEqual(terminal,2)
                else:
                    self.assertEqual(writer,{'state':'FAIL_CLOSED','reason':'WRITER_FENCED'})
                    self.assertEqual(terminal,1)
                with connect(source) as con:
                    keys={e['effect_key'] for e in rows(con)[:terminal]}
                self.assertEqual(f'late-{i}' in keys,writer['state']=='RECORDED')
                catchup(source,follower)
                promote(source,follower)
                self.assertEqual(state(source)['generation'],2)


if __name__=='__main__':
    unittest.main()
