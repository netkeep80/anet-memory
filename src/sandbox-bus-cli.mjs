#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import {
  createAckEnvelope,
  createEnvelope,
  inspectChannel,
  parseEnvelope,
  readAck,
  serializeEnvelope,
} from './sandbox-bus.mjs';

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'create':
      await createCommand(args);
      break;
    case 'ack':
      await ackCommand(args);
      break;
    case 'validate':
      await validateCommand(args);
      break;
    case 'inspect':
      await inspectCommand(args);
      break;
    default:
      usage();
      process.exitCode = 2;
  }
} catch (error) {
  const code = error?.code ? ` [${error.code}]` : '';
  console.error(`sandbox-bus error${code}: ${error.message}`);
  process.exitCode = 1;
}

async function createCommand(args) {
  const [source, target, sequenceText, previousText, payloadPath, outputPath, contentType = 'application/octet-stream'] = args;
  requireArgs(args, 6, 'create <source> <target> <sequence> <previous|null> <payload-file> <output-file> [content-type]');

  const payloadBytes = await readFile(payloadPath);
  const envelope = createEnvelope({
    source,
    target,
    sequence: parseSequence(sequenceText),
    previousMessageId: parsePrevious(previousText),
    payloadBytes,
    contentType,
  });
  await writeFile(outputPath, serializeEnvelope(envelope), 'utf8');
  printSummary(envelope, outputPath);
}

async function ackCommand(args) {
  const [source, target, sequenceText, previousText, ackFor, status, outputPath, detail = null] = args;
  requireArgs(args, 7, 'ack <source> <target> <sequence> <previous|null> <ack-for> <status> <output-file> [detail]');

  const envelope = createAckEnvelope({
    source,
    target,
    sequence: parseSequence(sequenceText),
    previousMessageId: parsePrevious(previousText),
    ackFor,
    status,
    detail,
  });
  await writeFile(outputPath, serializeEnvelope(envelope), 'utf8');
  printSummary(envelope, outputPath);
}

async function validateCommand(args) {
  const [messagePath] = args;
  requireArgs(args, 1, 'validate <message-file>');
  const envelope = parseEnvelope(await readFile(messagePath, 'utf8'));
  const result = summarize(envelope);
  if (envelope.type === 'ack') result.ack = readAck(envelope);
  console.log(JSON.stringify(result, null, 2));
}

async function inspectCommand(args) {
  const [source, target, ...paths] = args;
  if (!source || !target || paths.length === 0) {
    throw new Error('usage: inspect <source> <target> <message-file>...');
  }
  const envelopes = [];
  for (const path of paths) {
    envelopes.push(parseEnvelope(await readFile(path, 'utf8')));
  }
  const state = inspectChannel(envelopes, { source, target });
  console.log(JSON.stringify({
    ...state,
    accepted: state.accepted?.map(summarize),
    last_accepted: state.last_accepted ? summarize(state.last_accepted) : null,
  }, null, 2));
  if (state.state !== 'OK') process.exitCode = 3;
}

function summarize(envelope) {
  return {
    protocol: envelope.protocol,
    type: envelope.type,
    message_id: envelope.message_id,
    source: envelope.source,
    target: envelope.target,
    sequence: envelope.sequence,
    previous_message_id: envelope.previous_message_id,
    payload_sha256: envelope.payload_sha256,
    content_type: envelope.content_type,
  };
}

function printSummary(envelope, outputPath) {
  console.log(JSON.stringify({ ...summarize(envelope), output: outputPath }, null, 2));
}

function parsePrevious(value) {
  return value === 'null' || value === '-' ? null : value;
}

function parseSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`invalid sequence: ${value}`);
  return sequence;
}

function requireArgs(args, minimum, syntax) {
  if (args.length < minimum) throw new Error(`usage: ${syntax}`);
}

function usage() {
  console.error(`sandbox-bus/1 CLI

Commands:
  create <source> <target> <sequence> <previous|null> <payload-file> <output-file> [content-type]
  ack <source> <target> <sequence> <previous|null> <ack-for> <status> <output-file> [detail]
  validate <message-file>
  inspect <source> <target> <message-file>...`);
}
