/** Streaming 16 kHz PCM conditioning for PC/phone microphones.
 * Two gentle high-pass stages reject DC/low rumble; a low-pass reduces hiss.
 * This conditions audio, not a claim to classify speech semantically.
 */
export class MicFilter {
  constructor() { this.reset(); }
  reset() { this.previous = 0; this.high = 0; this.previousHigh = 0; this.high2 = 0; this.low = 0; }
  process(pcm) {
    const output = Buffer.alloc(pcm.length);
    const hp = Math.exp(-2 * Math.PI * 80 / 16000);
    const lp = 1 - Math.exp(-2 * Math.PI * 6000 / 16000);
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset);
      this.high = hp * (this.high + sample - this.previous); this.previous = sample;
      this.high2 = hp * (this.high2 + this.high - this.previousHigh); this.previousHigh = this.high;
      this.low += lp * (this.high2 - this.low);
      output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(this.low))), offset);
    }
    return output;
  }
}
