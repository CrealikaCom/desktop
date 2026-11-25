// Types for crealika-figures.js, the Crealika UI figures engine.

export interface Look {
  skin: string;
  hair: string;
  shirt: string;
  shirtDark: string;
  pants: string;
  bag: string | null;
  style: string;
  cap: string;
  /** Height and shoulder width multiplier. */
  hf: number;
  bw: number;
  glasses: boolean;
  /** A woman: long hair, ponytail, bun or headscarf (style 'scarf', colour cap), eyelashes and lips (men have short hair). */
  female: boolean;
  /** Skirt colour (skin-coloured legs under it, trousers `pants` with a headscarf) or null for trousers. */
  skirt: string | null;
}

/** An arm: side (-1 left, 1 right), hand position in metres from the point between the feet, item in hand. */
export interface ArmPose {
  side: -1 | 1;
  x: number;
  y: number;
  item?: (ctx: CanvasRenderingContext2D, handX: number, handY: number) => void;
}

export interface Face {
  blink?: boolean;
  gaze?: number;
  down?: number;
  talk?: number;
}

export interface Pose {
  /** The point between the feet on the canvas and the scale (pixels per metre). */
  x: number;
  y: number;
  s: number;
  facing?: "front" | "back" | "side";
  dir?: -1 | 1;
  walking?: boolean;
  phase?: number;
  hip?: number;
  shadow?: boolean;
  arms?: ArmPose[];
  face?: Face;
}

/** Chances: backpack (0.6), hard hat (0), woman (0.5), skirt for a woman (0.8). */
export declare function makeLook(opts?: { bag?: number; hardhat?: number; female?: number; skirt?: number }): Look;
export declare function draw(ctx: CanvasRenderingContext2D, look: Look, pose: Pose): void;
export declare function drawHead(ctx: CanvasRenderingContext2D, hx: number, hy: number, radius: number, look: Look, facing: string, face?: Face): void;
export declare function walkArms(look: Look, pose: Partial<Pose>): ArmPose[];
export declare function shoulderY(look: Look, hip?: number): number;
export declare function clampHand(look: Look, side: -1 | 1, x: number, y: number, hip?: number): { x: number; y: number };
export declare const util: {
  rand(a: number, b: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  clamp(value: number, min: number, max: number): number;
  shade(hex: string, factor: number): string;
  circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void;
  rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void;
};
export declare const CrealikaFigures: {
  makeLook: typeof makeLook;
  draw: typeof draw;
  drawHead: typeof drawHead;
  walkArms: typeof walkArms;
  shoulderY: typeof shoulderY;
  clampHand: typeof clampHand;
  util: typeof util;
};
export default CrealikaFigures;
