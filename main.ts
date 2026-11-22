// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA: 32-bit wrapping ints, a
// 256-value stack, 64 return addresses, 256 words of memory, ten traps, a
// 1,000,000 step cap and a 65,536 byte output cap. Runs every program in the
// input directory on its input bytes and writes stdout.bin + exit.txt per id.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OU = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Trap codes: underflow 2, overflow 3, div-zero 4, bad opcode 5, memory 6,
// call depth 7, empty RET 8, pc 9, steps 10, output 11.
function imm(op: number): number {
  if (op === 1) return 1; // PUSH8
  if (op === 2) return 4; // PUSH32
  if (op >= 0x30 && op <= 0x33) return 2; // JMP, JZ, JNZ, CALL
  if (op === 0 || (op >= 3 && op <= 7) || (op >= 0x10 && op <= 0x22) || op === 0x34 ||
      (op >= 0x40 && op <= 0x41) || (op >= 0x50 && op <= 0x53)) return 0;
  return -1;
}
class Trap extends Error {
  c: number;
  constructor(c: number) { super('trap ' + c); this.c = c; }
}
function run(p: Buffer, inp: Buffer): { b: Buffer; e: number } {
  const n = p.length, st = new Int32Array(256), cs = new Int32Array(64),
    mem = new Int32Array(256), out = Buffer.alloc(65536);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  const fail = (c: number): never => { throw new Trap(c); };
  const need = (a: number, b: number): void => {
    if (sp < a) fail(2);
    if (sp - a + b > 256) fail(3);
  };
  try {
    for (;;) {
      if (steps === 1000000) fail(10);
      if (pc < 0 || pc >= n) fail(9);
      const op = p[pc], im = imm(op);
      if (im < 0) fail(5);
      if (pc + im >= n) fail(9);
      steps++;
      const nx = pc + 1 + im; // address of the next instruction
      pc = nx;
      switch (op) {
        case 0: return { b: out.subarray(0, ol), e: 0 }; // HALT
        case 1: need(0, 1); st[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
        case 2: // PUSH32, little-endian, signed
          need(0, 1);
          st[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
          break;
        case 3: need(1, 0); sp--; break; // POP
        case 4: need(1, 2); st[sp] = st[sp - 1]; sp++; break; // DUP
        case 5: { // SWAP
          need(2, 2);
          const t = st[sp - 1];
          st[sp - 1] = st[sp - 2];
          st[sp - 2] = t;
          break;
        }
        case 6: need(2, 3); st[sp] = st[sp - 2]; sp++; break; // OVER
        case 7: { // ROT: (a b c -- b c a)
          need(3, 3);
          const a = st[sp - 3];
          st[sp - 3] = st[sp - 2];
          st[sp - 2] = st[sp - 1];
          st[sp - 1] = a;
          break;
        }
        case 0x17: need(1, 1); st[sp - 1] = -st[sp - 1] | 0; break; // NEG, wraps
        case 0x1b: need(1, 1); st[sp - 1] = ~st[sp - 1]; break; // NOT
        case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
        case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
        case 0x20: case 0x21: case 0x22: { // ADD SUB MUL DIV MOD DIVU MODU AND OR XOR SHL SHR SHRU EQ LT LTU
          need(2, 1);
          const b = st[sp - 1], a = st[sp - 2];
          let r: number;
          if (op === 0x10) r = (a + b) | 0;
          else if (op === 0x11) r = (a - b) | 0;
          else if (op === 0x12) r = Math.imul(a, b); // low 32 bits of the exact product
          else if (op === 0x13) { if (!b) fail(4); r = a === -2147483648 && b === -1 ? a : (a / b) | 0; }
          else if (op === 0x14) { if (!b) fail(4); r = b === -1 ? 0 : (a % b) | 0; } // sign of a
          else if (op === 0x15) { if (!b) fail(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; }
          else if (op === 0x16) { if (!b) fail(4); r = ((a >>> 0) % (b >>> 0)) | 0; }
          else if (op === 0x18) r = a & b;
          else if (op === 0x19) r = a | b;
          else if (op === 0x1a) r = a ^ b;
          else if (op === 0x1c) r = a << (b & 31);
          else if (op === 0x1d) r = a >> (b & 31);
          else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
          else if (op === 0x20) r = a === b ? 1 : 0;
          else if (op === 0x21) r = a < b ? 1 : 0;
          else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
          sp -= 2; st[sp++] = r; break;
        }
        case 0x30: case 0x31: case 0x32: { // JMP, JZ, JNZ: signed 16-bit offset off the next instruction
          const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
          if (op === 0x30) pc = nx + rel;
          else { need(1, 0); const v = st[--sp]; if (op === 0x31 ? v === 0 : v !== 0) pc = nx + rel; }
          break;
        }
        case 0x33: // CALL: push the next address, jump to the unsigned target
          if (cp === 64) fail(7);
          cs[cp++] = nx; pc = p[nx - 2] | (p[nx - 1] << 8); break;
        case 0x34: // RET
          if (!cp) fail(8);
          pc = cs[--cp]; break;
        case 0x40: { // LOAD
          need(1, 1);
          const a = st[sp - 1];
          if (a < 0 || a > 255) fail(6);
          st[sp - 1] = mem[a]; break;
        }
        case 0x41: { // STORE: (value address --), address is the top
          need(2, 0);
          const a = st[sp - 1], v = st[sp - 2];
          if (a < 0 || a > 255) fail(6);
          sp -= 2; mem[a] = v; break;
        }
        case 0x50: { // PRINT: decimal ASCII, '-' when negative, no newline
          need(1, 0);
          const s = String(st[sp - 1]);
          if (ol + s.length > 65536) fail(11);
          out.write(s, ol); ol += s.length; sp--; break;
        }
        case 0x51: // PUTC: one byte, low 8 bits
          need(1, 0);
          if (ol + 1 > 65536) fail(11);
          out[ol++] = st[--sp] & 255; break;
        case 0x52: need(0, 1); st[sp++] = ip < inp.length ? inp[ip++] : -1; break; // IN, -1 past the end
        case 0x53: need(1, 0); return { b: out.subarray(0, ol), e: st[--sp] & 255 }; // EXIT, low byte
        default: fail(5);
      }
    }
  } catch (e) {
    // A trap keeps the output written before it; its code is the exit code.
    if (e instanceof Trap) return { b: out.subarray(0, ol), e: e.c };
    throw e;
  }
}

// Answer every instance in the input directory, one at a time.
for (const id of readdirSync(IN).sort()) {
  const d = join(IN, id);
  let prog: Buffer;
  try { prog = readFileSync(join(d, 'program.bin')); } catch { continue; } // not an instance
  let inp: Buffer;
  try { inp = readFileSync(join(d, 'input.bin')); } catch { inp = Buffer.alloc(0); }
  let a: { b: Buffer; e: number };
  try { a = run(prog, inp); } catch { a = { b: Buffer.alloc(0), e: 0 }; }
  mkdirSync(join(OU, id), { recursive: true });
  writeFileSync(join(OU, id, 'stdout.bin'), a.b);
  writeFileSync(join(OU, id, 'exit.txt'), a.e + '\n');
}
