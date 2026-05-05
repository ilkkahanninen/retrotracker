/**
 * Paula emulation with BLEP synthesis, RC + LED filters, and 2× FIR
 * downsampling. Direct port of pt2-clone's audio path.
 *
 * Pipeline per output sample:
 *   1. Run 4 voices at the 2× mix rate. Each voice has phase-driven
 *      sample-and-hold playback (no waveform interpolation); discontinuities
 *      at byte transitions are corrected by minimum-phase BLEP impulses
 *      added to a circular buffer (Blep.add) and convolved on output
 *      (Blep.run).
 *   2. Sum into hard-panned L/R (LRRL).
 *   3. Apply Amiga RC filters (one-pole HP always; one-pole LP A500 only;
 *      two-pole LED if enabled) at the 2× rate.
 *   4. Polyphase half-band FIR downsample to the output rate.
 *   5. Caller applies stereo separation and final normalization.
 */

import { PAULA_CLOCK_PAL } from '../mod/format';

export const PAULA_VOICES = 4;

// --- BLEP --------------------------------------------------------------------
// aciddose's minimum-phase BLEP table from pt2_blep.c. ZC=16 OS=16 SP=16,
// so NS=16 and the buffer size is RNS+1=32. The 257th entry is a sentinel
// zero used by linear interpolation at the table tail.

const BLEP_NS = 16;
const BLEP_RNS = 31;
const BLEP_SP = 16;

// prettier-ignore
const BLEP_TABLE = new Float64Array([
  1.000047730261351741631870027,
  1.000070326525919428561905988,
  1.000026295486963423542192686,
  0.999910424773336803383472216,
  0.999715744379055859525351480,
  0.999433014919733908598686867,
  0.999050085771328588712947294,
  0.998551121919525108694415394,
  0.997915706233591937035498631,
  0.997117832692634098457062919,
  0.996124815495205595539118804,
  0.994896148570364013963285288,
  0.993382359323431773923118726,
  0.991523909003057091204880180,
  0.989250199364479221308954493,
  0.986478750833182482793404233,
  0.983114620682589257505412661,
  0.979050130425507592057954298,
  0.974164969358674692756494551,
  0.968326735771705471300663248,
  0.961391968634788374181709969,
  0.953207710646355677042151910,
  0.943613628528589098998224927,
  0.932444698727279863703643059,
  0.919534446669115101968827730,
  0.904718706053873278349897191,
  0.887839842029686909796737382,
  0.868751359331251915563143484,
  0.847322794437510795617640724,
  0.823444770447693374926245724,
  0.797034075604916458779314326,
  0.768038612100722994924240083,
  0.736442051783192774827568883,
  0.702268030364621043126760469,
  0.665583712234169455612686761,
  0.626502564400415073997407944,
  0.585186190589438104403541274,
  0.541845095055891845525763983,
  0.496738269945924404424886234,
  0.450171529567763739621000241,
  0.402494548939336449500103754,
  0.354096601546017020201162495,
  0.305401031227847563620514393,
  0.256858534249934655768754510,
  0.208939368513054252174399039,
  0.162124646097439151226637932,
  0.116896901459689991908952322,
  0.073730159227936173382822460,
  0.033079751373986221452128120,
  -0.004627847551233893637345762,
  -0.039004887382349466562470042,
  -0.069711629260494178961238276,
  -0.096464776709362487494558991,
  -0.119044790560825133884925719,
  -0.137301851759562276722448360,
  -0.151160268717908163882412964,
  -0.160621165999489917686204876,
  -0.165763337555641210308010614,
  -0.166742199141503621984128358,
  -0.163786829309547077304642926,
  -0.157195144771094669211564110,
  -0.147327312088839507131510231,
  -0.134597551740997606328775760,
  -0.119464540741507418974975963,
  -0.102420664473805989036492292,
  -0.083980405628003879092702277,
  -0.064668186778692057781192659,
  -0.045006002136687713044427284,
  -0.025501182606377806316722001,
  -0.006634636085273460347211394,
  0.011150108072625494748386643,
  0.027456744995838545247979212,
  0.041944658451493331552395460,
  0.054335772988313046916175608,
  0.064419613137017092685532305,
  0.072056443764197217194400480,
  0.077178424602408784993556878,
  0.079788772844964592212413379,
  0.079958988468210145938996902,
  0.077824255600564926083073658,
  0.073577187846729327769246254,
  0.067460134194076051827870799,
  0.059756303384108616638670242,
  0.050779997099921050929260957,
  0.040866264989502618099059816,
  0.030360306751458156215850437,
  0.019606947961234157812304701,
  0.008940507097049575288560952,
  -0.001324648208126466466388882,
  -0.010902586500777250097526938,
  -0.019543107356485005243751374,
  -0.027037657667711743197935803,
  -0.033223730539404389139335194,
  -0.037987660680654206091233505,
  -0.041265784496258707536586741,
  -0.043043987097204458591725995,
  -0.043355710312406585404954029,
  -0.042278543756813086185175621,
  -0.039929563528408616723819335,
  -0.036459618831699062979634363,
  -0.032046794692908199542191738,
  -0.026889298182776331241905510,
  -0.021198025763611533928143515,
  -0.015189070430455576393713457,
  -0.009076419455364113236806034,
  -0.003065077316892155564337363,
  0.002655175361548794011473662,
  0.007915206247809156159256361,
  0.012570993866018958726171739,
  0.016507022146950881685834034,
  0.019638542128970374461838233,
  0.021912677934460975809338734,
  0.023308395228452325614876273,
  0.023835389125096861917540991,
  0.023531983633596965932444078,
  0.022462165098004915897433875,
  0.020711896771322700627759872,
  0.018384880003473082210607714,
  0.015597939105523964467558962,
  0.012476211636472618604631890,
  0.009148323764166686397625305,
  0.005741721847351755579624832,
  0.002378317065490789024989615,
  -0.000829419425005380466127403,
  -0.003781796760683148444365242,
  -0.006394592475568152724341164,
  -0.008601029202315702004710829,
  -0.010353009833494400057651852,
  -0.011621609729198234539637724,
  -0.012396851839770069853008394,
  -0.012686815497510708569683935,
  -0.012516151297987356677543502,
  -0.011924092281628086154032786,
  -0.010962065062340150406461348,
  -0.009691013345942120493781147,
  -0.008178550345073604815882007,
  -0.006496056025074358440674072,
  -0.004715830178801836899959987,
  -0.002908403455554361104196115,
  -0.001140096220006421448914247,
  0.000529099845866712065883819,
  0.002047259427257062253113773,
  0.003371840725899812995364213,
  0.004470560830528139475981142,
  0.005321826318522163493107691,
  0.005914733331712991419581993,
  0.006248666963769690732566353,
  0.006332543236118748190832672,
  0.006183747823531677602348910,
  0.005826833745009315536356187,
  0.005292045316197638814281756,
  0.004613737750803969042689978,
  0.003828761006839943078355892,
  0.002974873016054367744903653,
  0.002089241623845963964634098,
  0.001207086791118088800120467,
  0.000360505313776118753877481,
  -0.000422490021201840063209965,
  -0.001118695810940623525803206,
  -0.001710197865787731110603920,
  -0.002184605984988852254297109,
  -0.002535053949380879686342771,
  -0.002759983640474954029453425,
  -0.002862739419386348127538611,
  -0.002851004510552685496799219,
  -0.002736115017663406229209144,
  -0.002532289317276390557681642,
  -0.002255810970882980801693884,
  -0.001924202080457771161722813,
  -0.001555421358101014960712005,
  -0.001167117308478276627506376,
  -0.000775962090624877551779670,
  -0.000397086112821087974713435,
  -0.000043627508742770710237387,
  0.000273595371614305691784774,
  0.000546286179945486565119606,
  0.000768750680536383766867925,
  0.000937862797633428843004089,
  0.001052928740415311594305625,
  0.001115464566897328381120391,
  0.001128904823558016723081265,
  0.001098261208043675284801166,
  0.001029750572351520628011645,
  0.000930411077785372455858925,
  0.000807724029027989654482000,
  0.000669256978018619233528064,
  0.000522341243078797709889494,
  0.000373794189875729877727689,
  0.000229693626208723626408101,
  0.000095208625460110475721871,
  -0.000025511844279469758173208,
  -0.000129393822077144692462430,
  -0.000214440509776957504047001,
  -0.000279687383686450809737456,
  -0.000325117484787396354272565,
  -0.000351545144152561614761532,
  -0.000360476947384593608518510,
  -0.000353958823942885139873099,
  -0.000334417806276329982514278,
  -0.000304506298090264292902779,
  -0.000266955691183075056582136,
  -0.000224444953912546549387383,
  -0.000179488462294699944012469,
  -0.000134345936549333598141603,
  -0.000090955956048889888797271,
  -0.000050893220267083281950406,
  -0.000015348557788785960678823,
  0.000014870297520588306796089,
  0.000039319915274267510328903,
  0.000057887658269859997505705,
  0.000070747063526119185008535,
  0.000078305819543209774719408,
  0.000081149939344861922907622,
  0.000079987451948008292520673,
  0.000075594520611004130655058,
  0.000068766382254997158183021,
  0.000060274927715552435942073,
  0.000050834144795034220151546,
  0.000041074060306237671633470,
  0.000031523273709852359548023,
  0.000022599698095009569128290,
  0.000014608732178951863478521,
  0.000007747790946751235789929,
  0.000002115927046159247276264,
  -0.000002272821614624657917699,
  -0.000005473727618614671290435,
  -0.000007594607649309153682893,
  -0.000008779148282948222000235,
  -0.000009191289914471795693680,
  -0.000009001415957147717553273,
  -0.000008374862616584595860708,
  -0.000007463035714495605026032,
  -0.000006397209079216532043657,
  -0.000005284894977678962862369,
  -0.000004208528817468251939280,
  -0.000003226102468093129124012,
  -0.000002373314390120065336351,
  -0.000001666778737492929471595,
  -0.000001107845639559032712541,
  -0.000000686624974759576246945,
  -0.000000385868818649388185867,
  -0.000000184445440432801241354,
  -0.000000060222272723601931954,
  0.000000007740724047001495273,
  0.000000037708832885684096027,
  0.000000044457942869060847864,
  0.000000039034296310091607592,
  0.000000028962932871006776366,
  0.000000018763994698223029203,
  0.000000010636937008622986639,
  0.000000005187099504706206719,
  0.000000002093670467469700098,
  0.000000000648951812097509606,
  0.000000000132018063854003986,
  0.000000000011591335682393882,
  0.000000000000000000000000000,
  0.000000000000000000000000000,
]);

class Blep {
  index = 0;
  samplesLeft = 0;
  readonly buf = new Float64Array(BLEP_RNS + 1);
  lastValue = 0;

  add(offset: number, amplitude: number): void {
    let f = offset * BLEP_SP;
    const ti = f | 0;
    f -= ti;
    let bi = this.index;
    for (let n = 0; n < BLEP_NS; n++) {
      const k = ti + n * BLEP_SP;
      const a = BLEP_TABLE[k]!;
      const b = BLEP_TABLE[k + 1]!;
      this.buf[bi] = this.buf[bi]! + amplitude * (a + (b - a) * f);
      bi = (bi + 1) & BLEP_RNS;
    }
    this.samplesLeft = BLEP_NS;
  }

  run(input: number): number {
    const out = input + this.buf[this.index]!;
    this.buf[this.index] = 0;
    this.index = (this.index + 1) & BLEP_RNS;
    this.samplesLeft--;
    return out;
  }

  reset(): void {
    this.index = 0;
    this.samplesLeft = 0;
    this.buf.fill(0);
    this.lastValue = 0;
  }
}

// --- RC filters --------------------------------------------------------------

class OnePoleFilter {
  private a0 = 0;
  private b1 = 0;
  private tmpL = 0;
  private tmpR = 0;

  setup(audioRate: number, cutoff: number): void {
    if (cutoff >= audioRate / 2) cutoff = audioRate / 2 - 1e-4;
    this.b1 = Math.exp((-2 * Math.PI) * cutoff / audioRate);
    this.a0 = 1 - this.b1;
  }

  reset(): void {
    this.tmpL = this.tmpR = 0;
  }

  /** Stereo low-pass; writes results back via the `inOut` 2-tuple. */
  lpStereo(inOut: [number, number]): void {
    this.tmpL = inOut[0] * this.a0 + this.tmpL * this.b1;
    this.tmpR = inOut[1] * this.a0 + this.tmpR * this.b1;
    inOut[0] = this.tmpL;
    inOut[1] = this.tmpR;
  }

  /** Stereo high-pass: y = x − LP(x). */
  hpStereo(inOut: [number, number]): void {
    const l = inOut[0];
    const r = inOut[1];
    this.tmpL = l * this.a0 + this.tmpL * this.b1;
    this.tmpR = r * this.a0 + this.tmpR * this.b1;
    inOut[0] = l - this.tmpL;
    inOut[1] = r - this.tmpR;
  }
}

class TwoPoleFilter {
  private a1 = 0;
  private a2 = 0;
  private b1 = 0;
  private b2 = 0;
  private tL0 = 0; private tL1 = 0; private tL2 = 0; private tL3 = 0;
  private tR0 = 0; private tR1 = 0; private tR2 = 0; private tR3 = 0;

  setup(audioRate: number, cutoff: number, qFactor: number): void {
    if (cutoff >= audioRate / 2) cutoff = audioRate / 2 - 1e-4;
    const a = 1 / Math.tan((Math.PI * cutoff) / audioRate);
    const b = 1 / qFactor;
    this.a1 = 1 / (1 + b * a + a * a);
    this.a2 = 2 * this.a1;
    this.b1 = 2 * (1 - a * a) * this.a1;
    this.b2 = (1 - b * a + a * a) * this.a1;
  }

  reset(): void {
    this.tL0 = this.tL1 = this.tL2 = this.tL3 = 0;
    this.tR0 = this.tR1 = this.tR2 = this.tR3 = 0;
  }

  lpStereo(inOut: [number, number]): void {
    const inL = inOut[0];
    const inR = inOut[1];
    const lo = inL * this.a1 + this.tL0 * this.a2 + this.tL1 * this.a1 - this.tL2 * this.b1 - this.tL3 * this.b2;
    const ro = inR * this.a1 + this.tR0 * this.a2 + this.tR1 * this.a1 - this.tR2 * this.b1 - this.tR3 * this.b2;
    this.tL1 = this.tL0; this.tL0 = inL; this.tL3 = this.tL2; this.tL2 = lo;
    this.tR1 = this.tR0; this.tR0 = inR; this.tR3 = this.tR2; this.tR2 = ro;
    inOut[0] = lo;
    inOut[1] = ro;
  }
}

// --- 2× polyphase half-band downsampler -------------------------------------
// Coefficients from pt2_downsample2x.c (Remez, 59 taps, halfband). State is
// 29 doubles per channel, matching the C tap-line (t01..t29). Each call
// consumes 2 oversampled inputs and emits 1 output sample.

const C00 = 0.500000000000001776356839400;
const C01 = 0.316796099629279681586524475;
const C03 = -0.101638770668561695398324218;
const C05 = 0.056469397591722876594833025;
const C07 = -0.035898691728282271229399925;
const C09 = 0.023848934428624003062369141;
const C11 = -0.015961026468464808297786917;
const C13 = 0.010547947951963959276056038;
const C15 = -0.006789354746338562181240395;
const C17 = 0.004207318621831869671912063;
const C19 = -0.002480664366371574183767201;
const C21 = 0.001372073862198802066819647;
const C23 = -0.000698236372446042839051694;
const C25 = 0.000317104911171300647004800;
const C27 = -0.000121433207895608810135933;
const C29 = 0.000035018885257113032771856;

class Downsample2x {
  // tap line indices 1..29 (index 0 unused for parity with C)
  private readonly t = new Float64Array(30);

  reset(): void {
    this.t.fill(0);
  }

  step(s1: number, s2: number): number {
    // Mirrors downsample2x_L/_R from pt2_downsample2x.c verbatim.
    const x00 = s2 * C00, x01 = s1 * C01;
    const x03 = s1 * C03, x05 = s1 * C05;
    const x07 = s1 * C07, x09 = s1 * C09;
    const x11 = s1 * C11, x13 = s1 * C13;
    const x15 = s1 * C15, x17 = s1 * C17;
    const x19 = s1 * C19, x21 = s1 * C21;
    const x23 = s1 * C23, x25 = s1 * C25;
    const x27 = s1 * C27, x29 = s1 * C29;

    const t = this.t;
    const out = t[29]! + x29;

    t[29] = t[28]! + x27;
    t[28] = t[27]! + x25;
    t[27] = t[26]! + x23;
    t[26] = t[25]! + x21;
    t[25] = t[24]! + x19;
    t[24] = t[23]! + x17;
    t[23] = t[22]! + x15;
    t[22] = t[21]! + x13;
    t[21] = t[20]! + x11;
    t[20] = t[19]! + x09;
    t[19] = t[18]! + x07;
    t[18] = t[17]! + x05;
    t[17] = t[16]! + x03;
    t[16] = t[15]! + x01;
    t[15] = t[14]! + x01 + x00;
    t[14] = t[13]! + x03;
    t[13] = t[12]! + x05;
    t[12] = t[11]! + x07;
    t[11] = t[10]! + x09;
    t[10] = t[9]! + x11;
    t[9]  = t[8]! + x13;
    t[8]  = t[7]! + x15;
    t[7]  = t[6]! + x17;
    t[6]  = t[5]! + x19;
    t[5]  = t[4]! + x21;
    t[4]  = t[3]! + x23;
    t[3]  = t[2]! + x25;
    t[2]  = t[1]! + x27;
    t[1]  =          x29;

    return out;
  }
}

// --- Voice -------------------------------------------------------------------

class PaulaVoice {
  // Latched DMA-side registers (written by tracker, used on next refetch).
  data: Int8Array | null = null; // sample data (whole sample buffer)
  startOffsetBytes = 0;          // offset into `data` for AUD_LC pointer
  lengthWords = 0;               // AUD_LEN
  loopStartBytes = 0;
  loopLengthWords = 0;
  perDelta = 0;                  // AUD_PER_delta = clockDiv / period
  vol = 0;                       // AUD_VOL: realVol * (1 / (128 * 64))

  // Active DMA state
  dmaActive = false;
  dmaTrigger = false;
  nextSampleStage = false;
  dat0 = 0; dat1 = 0;             // 2-byte DMA buffer
  /** Mirrors pt2-clone's sampleCounter: 2 = fresh fetch needed, 1 = use dat0
   *  (after fetch), 0 = exhausted, refetch next call. */
  sampleCounter = 0;
  /** Whether we're playing the initial region (true) or the loop region (false). */
  inInitialRegion = true;
  cursorBytes = 0;                // current byte index into `data`
  endBytes = 0;                   // exclusive end of current region
  dSample = 0;
  dDelta = 0;
  dPhase = 0;
  dLastDelta = 0;
  dLastPhase = 0;
  dBlepOffset = 0;

  reset(): void {
    this.data = null;
    this.startOffsetBytes = 0;
    this.lengthWords = 0;
    this.loopStartBytes = 0;
    this.loopLengthWords = 0;
    this.perDelta = 0;
    this.vol = 0;
    this.dmaActive = false;
    this.dmaTrigger = false;
    this.nextSampleStage = false;
    this.dat0 = this.dat1 = 0;
    this.sampleCounter = 0;
    this.inInitialRegion = true;
    this.cursorBytes = 0;
    this.endBytes = 0;
    this.dSample = 0;
    this.dDelta = 0;
    this.dPhase = 0;
    this.dLastDelta = 0;
    this.dLastPhase = 0;
    this.dBlepOffset = 0;
  }
}

// --- Paula -------------------------------------------------------------------

export type AmigaModel = 'A1200' | 'A500';

export class Paula {
  readonly outputRate: number;
  /** Mix rate (paula rate). 2× outputRate when oversamplingFlag is true. */
  readonly paulaRate: number;
  /** True when we run the mix at 2× and 2x-downsample on output. */
  readonly oversampling: boolean;

  private readonly periodToDeltaDiv: number;
  private readonly voices: PaulaVoice[] = [];
  private readonly bleps: Blep[] = [];
  private readonly filterLo = new OnePoleFilter();
  private readonly filterHi = new OnePoleFilter();
  private readonly filterLED = new TwoPoleFilter();
  private readonly dsL = new Downsample2x();
  private readonly dsR = new Downsample2x();
  private model: AmigaModel;
  private useLowpass: boolean;
  private useHighpass: boolean;
  private useLED = false;

  // Reusable scratch for filter passes (avoid allocating each sample).
  private readonly stereoScratch: [number, number] = [0, 0];
  // Reusable mix buffers for one chunk; grown lazily in generate().
  private mixL: Float64Array = new Float64Array(0);
  private mixR: Float64Array = new Float64Array(0);
  /**
   * Per-channel peak amplitude accumulator for VU meters. Updated
   * sample-by-sample inside `generate()`; the worklet drains it via
   * `peakSnapshotAndReset` on a fixed UI-rate cadence (~30 Hz). Values
   * are pre-pan and post-volume — a muted channel (volume=0) reads 0
   * automatically, no extra wiring needed.
   */
  private readonly channelPeaks = new Float64Array(PAULA_VOICES);

  constructor(outputRate: number, model: AmigaModel = 'A1200') {
    this.outputRate = outputRate;
    this.oversampling = outputRate < 96000;
    this.paulaRate = this.oversampling ? outputRate * 2 : outputRate;
    // PAULA_CLOCK_PAL (7.094 MHz, the CPU/CCK*2 convention) is twice the
    // actual byte-rate divisor on Paula; one byte takes two CCK ticks.
    // pt2-clone uses the half value (~3.547 MHz). Divide by 2 to match.
    this.periodToDeltaDiv = (PAULA_CLOCK_PAL / 2) / this.paulaRate;

    for (let i = 0; i < PAULA_VOICES; i++) {
      this.voices.push(new PaulaVoice());
      this.bleps.push(new Blep());
    }

    this.model = model;
    this.useLowpass = false;
    this.useHighpass = false;
    this.configureModelFilters();

    // 2-pole Sallen-Key LED filter: R1=R2=10kΩ, C1=6.8nF, C2=3.9nF
    const R1 = 10_000, R2 = 10_000, C1 = 6.8e-9, C2 = 3.9e-9;
    const ledCutoff = 1 / (2 * Math.PI * Math.sqrt(R1 * R2 * C1 * C2));
    const ledQ = Math.sqrt(R1 * R2 * C1 * C2) / (C2 * (R1 + R2));
    this.filterLED.setup(this.paulaRate, ledCutoff, ledQ);
  }

  /**
   * Reconfigure the RC filter coefficients for the active Amiga model.
   * Used both at construction and from `setAmigaModel` to swap models at
   * runtime (e.g. when the user changes the Settings preference). The LED
   * filter is shared between models and isn't re-set up.
   */
  private configureModelFilters(): void {
    if (this.model === 'A1200') {
      // A1200 LP cutoff (~34kHz) is above the audible range; pt2-clone skips it.
      this.useLowpass = false;
      this.useHighpass = true;
      // 1-pole HP: R=1360Ω, C=22µF → ~5.319 Hz
      this.filterHi.setup(this.paulaRate, 1 / (2 * Math.PI * 1360 * 2.2e-5));
    } else {
      this.useLowpass = true;
      this.useHighpass = true;
      // 1-pole LP: R=360Ω, C=0.1µF → ~4421 Hz
      this.filterLo.setup(this.paulaRate, 1 / (2 * Math.PI * 360 * 1e-7));
      // 1-pole HP: R=1390Ω, C=22.33µF → ~5.128 Hz
      this.filterHi.setup(this.paulaRate, 1 / (2 * Math.PI * 1390 * 2.233e-5));
    }
  }

  /**
   * Swap the active Amiga model at runtime. Filter coefficients are
   * recomputed in place and the filter state is reset so the previous
   * model's RC history doesn't leak into the new one's response curve.
   */
  setAmigaModel(model: AmigaModel): void {
    if (model === this.model) return;
    this.model = model;
    this.filterLo.reset();
    this.filterHi.reset();
    this.configureModelFilters();
  }

  setLEDFilter(on: boolean): void {
    if (on !== this.useLED) this.filterLED.reset();
    this.useLED = on;
  }

  // --- Tracker-facing register writes ---------------------------------------

  setSample(
    ch: number,
    data: Int8Array,
    startOffsetBytes: number,
    lengthWords: number,
    loopStartBytes: number,
    loopLengthWords: number,
  ): void {
    const v = this.voices[ch]!;
    v.data = data;
    v.startOffsetBytes = startOffsetBytes;
    v.lengthWords = lengthWords;
    v.loopStartBytes = loopStartBytes;
    v.loopLengthWords = loopLengthWords;
  }

  /** Set the period for a voice. 0 → 65536 (Amiga quirk); clamped to ≥113. */
  setPeriod(ch: number, period: number): void {
    const v = this.voices[ch]!;
    let p = period;
    if (p === 0) p = 65536;
    else if (p < 113) p = 113;
    v.perDelta = this.periodToDeltaDiv / p;
    if (v.dLastDelta === 0) v.dLastDelta = v.perDelta;
  }

  /** Set the volume (0..64). */
  setVolume(ch: number, vol: number): void {
    const v = this.voices[ch]!;
    let r = vol & 0x7f;
    if (r > 64) r = 64;
    v.vol = r * (1 / (128 * 64));
  }

  /** Trigger DMA: start playing `data` from `startOffsetBytes`. */
  startDMA(ch: number): void {
    const v = this.voices[ch]!;
    if (!v.data) return;
    v.dmaTrigger = true;
    v.sampleCounter = 0;
    v.cursorBytes = v.startOffsetBytes;
    v.endBytes = v.startOffsetBytes + v.lengthWords * 2;
    v.inInitialRegion = true;
    // refetchPeriod
    v.dLastPhase = v.dPhase;
    v.dLastDelta = v.dDelta;
    v.dBlepOffset = v.dLastDelta > 0 ? v.dLastPhase / v.dLastDelta : 0;
    v.dDelta = v.perDelta;
    v.nextSampleStage = true;
    v.dPhase = 0;
    v.dmaActive = true;
  }

  stopDMA(ch: number): void {
    this.voices[ch]!.dmaActive = false;
  }

  /**
   * Read the per-channel peak amplitudes accumulated since the last call,
   * then zero the accumulator. Returns absolute pre-pan values straight from
   * the mix loop — typically [0, ~1.5] (PT max-volume sample is ~1.0; BLEP
   * transitions can briefly overshoot). Caller normalises for display.
   */
  peakSnapshotAndReset(out: Float32Array): void {
    for (let i = 0; i < PAULA_VOICES; i++) {
      out[i] = this.channelPeaks[i]!;
      this.channelPeaks[i] = 0;
    }
  }

  reset(): void {
    for (const v of this.voices) v.reset();
    for (const b of this.bleps) b.reset();
    this.filterLo.reset();
    this.filterHi.reset();
    this.filterLED.reset();
    this.dsL.reset();
    this.dsR.reset();
    this.useLED = false;
    this.channelPeaks.fill(0);
  }

  // --- Sample generation ----------------------------------------------------

  /**
   * Emit `outputFrames` output-rate stereo doubles. Internally generates
   * `outputFrames * (oversampling ? 2 : 1)` mix-rate samples and downsamples.
   * Hard-pan LRRL; caller does mid/side + final scaling.
   */
  generate(outL: Float64Array, outR: Float64Array, outputFrames: number, offset: number): void {
    if (outputFrames <= 0) return;
    const mixCount = this.oversampling ? outputFrames * 2 : outputFrames;

    if (this.mixL.length < mixCount) {
      this.mixL = new Float64Array(mixCount);
      this.mixR = new Float64Array(mixCount);
    }
    const mL = this.mixL;
    const mR = this.mixR;
    for (let i = 0; i < mixCount; i++) {
      mL[i] = 0;
      mR[i] = 0;
    }

    for (let ci = 0; ci < PAULA_VOICES; ci++) {
      const v = this.voices[ci]!;
      if (!v.dmaActive || !v.data) continue;
      const blep = this.bleps[ci]!;
      const isLeft = ci === 0 || ci === 3;
      const dst = isLeft ? mL : mR;

      let peak = this.channelPeaks[ci]!;
      for (let j = 0; j < mixCount; j++) {
        if (v.nextSampleStage) {
          v.nextSampleStage = false;
          this.advanceVoice(v, blep);
          if (!v.dmaActive) break;
        }
        let sample = v.dSample;
        if (blep.samplesLeft > 0) sample = blep.run(sample);
        dst[j] = dst[j]! + sample;
        const av = sample < 0 ? -sample : sample;
        if (av > peak) peak = av;

        v.dPhase += v.dDelta;
        if (v.dPhase >= 1) {
          v.dPhase -= 1;
          v.dLastPhase = v.dPhase;
          v.dLastDelta = v.dDelta;
          v.dBlepOffset = v.dLastDelta > 0 ? v.dLastPhase / v.dLastDelta : 0;
          v.dDelta = v.perDelta;
          v.nextSampleStage = true;
        }
      }
      this.channelPeaks[ci] = peak;
    }

    // Apply RC + LED filters at the mix rate.
    const s = this.stereoScratch;
    for (let i = 0; i < mixCount; i++) {
      s[0] = mL[i]!;
      s[1] = mR[i]!;
      if (this.useLowpass) this.filterLo.lpStereo(s);
      if (this.useLED)     this.filterLED.lpStereo(s);
      if (this.useHighpass) this.filterHi.hpStereo(s);
      mL[i] = s[0];
      mR[i] = s[1];
    }

    // Downsample (or copy through) into outL/outR at offset..offset+outputFrames.
    if (this.oversampling) {
      for (let i = 0; i < outputFrames; i++) {
        const k = i * 2;
        outL[offset + i] = this.dsL.step(mL[k]!, mL[k + 1]!);
        outR[offset + i] = this.dsR.step(mR[k]!, mR[k + 1]!);
      }
    } else {
      for (let i = 0; i < outputFrames; i++) {
        outL[offset + i] = mL[i]!;
        outR[offset + i] = mR[i]!;
      }
    }
  }

  // --- Internal -------------------------------------------------------------

  /**
   * Mirrors pt2-clone's `nextSample()`. One call per phase wrap (or once
   * post-startDMA for the initial fetch). `sampleCounter` tracks how many
   * bytes remain in the 2-byte DMA buffer:
   *   - 0: fetch a new word from the cursor (or loop / stop)
   *   - 2/1: use buffered dat0, then shift dat1 → dat0
   */
  private advanceVoice(v: PaulaVoice, b: Blep): void {
    if (v.sampleCounter === 0) {
      if (!v.dmaTrigger) {
        // End-of-region check (DMA's own length counter wrapped).
        if (v.cursorBytes >= v.endBytes) {
          if (v.loopLengthWords > 1) {
            v.inInitialRegion = false;
            v.cursorBytes = v.loopStartBytes;
            v.endBytes = v.loopStartBytes + v.loopLengthWords * 2;
          } else {
            v.dmaActive = false;
            v.dSample = 0;
            return;
          }
        }
      }
      v.dmaTrigger = false;

      const data = v.data!;
      const i0 = v.cursorBytes;
      const len = data.byteLength;
      v.dat0 = i0 < len ? data[i0]! : 0;
      v.dat1 = (i0 + 1) < len ? data[i0 + 1]! : 0;
      v.cursorBytes = i0 + 2;
      v.sampleCounter = 2;
    }

    v.dSample = v.dat0 * v.vol;
    if (v.dSample !== b.lastValue) {
      if (v.dLastDelta > v.dLastPhase) {
        b.add(v.dBlepOffset, b.lastValue - v.dSample);
      }
      b.lastValue = v.dSample;
    }
    // Shift the buffered second byte down for the next call.
    v.dat0 = v.dat1;
    v.sampleCounter--;
  }
}
