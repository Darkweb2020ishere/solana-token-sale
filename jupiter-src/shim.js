import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;
globalThis.global = globalThis.global || globalThis;
globalThis.process = globalThis.process || { env: {}, browser: true, version: '' };
