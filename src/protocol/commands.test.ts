import { describe, expect, it } from 'vitest';
import { intoVialPacket } from '../transport/types';
import {
  buildGetKeyboardDef,
  buildGetKeyboardId,
  buildGetProtocolVersion,
  buildGetSize,
  parseKeyboardId,
  parseProtocolVersion,
  parseSize,
  readU16BE,
  readU32LE,
  ViaCommand,
  VialSubCommand,
  writeU16LE,
} from './commands';

describe('byte helpers', () => {
  it('readU16BE reads big-endian u16', () => {
    expect(readU16BE(new Uint8Array([0, 0x12, 0x34, 0]), 1)).toBe(0x1234);
  });

  it('readU32LE reads little-endian u32', () => {
    expect(readU32LE(new Uint8Array([0x12, 0x34, 0x56, 0x78]), 0)).toBe(0x78563412);
  });

  it('writeU16LE writes little-endian u16', () => {
    const buf = new Uint8Array(4);
    writeU16LE(buf, 1, 0xabcd);
    expect(Array.from(buf)).toEqual([0, 0xcd, 0xab, 0]);
  });
});

describe('builders', () => {
  it('buildGetProtocolVersion sets the right command id', () => {
    const p = buildGetProtocolVersion();
    expect(p[0]).toBe(ViaCommand.GetProtocolVersion);
    expect(p.length).toBe(32);
  });

  it('buildGetKeyboardId nests under Vial', () => {
    const p = buildGetKeyboardId();
    expect(p[0]).toBe(ViaCommand.Vial);
    expect(p[1]).toBe(VialSubCommand.GetKeyboardId);
  });

  it('buildGetSize nests under Vial', () => {
    const p = buildGetSize();
    expect(p[0]).toBe(ViaCommand.Vial);
    expect(p[1]).toBe(VialSubCommand.GetSize);
  });

  it('buildGetKeyboardDef encodes the page index little-endian', () => {
    const p = buildGetKeyboardDef(0x0142);
    expect(p[0]).toBe(ViaCommand.Vial);
    expect(p[1]).toBe(VialSubCommand.GetKeyboardDef);
    expect(p[2]).toBe(0x42);
    expect(p[3]).toBe(0x01);
  });
});

describe('parsers', () => {
  it('parseProtocolVersion reads BE u16 at byte 1', () => {
    const reply = new Uint8Array(new ArrayBuffer(32));
    reply[1] = 0x00;
    reply[2] = 0x09;
    expect(parseProtocolVersion(intoVialPacket(reply))).toBe(9);
  });

  it('parseKeyboardId extracts version, uid and feature flags', () => {
    const reply = new Uint8Array(new ArrayBuffer(32));
    // Vial protocol version = 6 (LE u32 at 0..4)
    reply[0] = 6;
    // UID at 4..12
    const uid = [0xb9, 0xbc, 0x09, 0xb2, 0x9d, 0x37, 0x4c, 0xea];
    uid.forEach((b, i) => {
      reply[4 + i] = b;
    });
    // feature flags at byte 12
    reply[12] = 1;
    const got = parseKeyboardId(intoVialPacket(reply));
    expect(got.vialProtocolVersion).toBe(6);
    expect(Array.from(got.uid)).toEqual(uid);
    expect(got.featureFlags).toBe(1);
  });

  it('parseSize reads LE u32 at byte 0', () => {
    const reply = new Uint8Array(new ArrayBuffer(32));
    reply[0] = 0x80;
    reply[1] = 0x02;
    expect(parseSize(intoVialPacket(reply))).toBe(0x0280);
  });
});
