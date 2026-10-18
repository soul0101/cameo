/** Shared domain types. Screens import from here, never redefine. */

/** Normalised box in [0..1] relative to the frame (x,y = top-left). */
export interface Box { x: number; y: number; w: number; h: number }

export interface Shot {
  /** Shot id from ingest (`C01`). */
  id: string;
  /** Seconds in the episode. */
  tIn: number;
  tOut: number;
  scene: string;
  description: string;
  /** The episode video with a media fragment for this shot. */
  media: string;
  /** The shot's keyframe. */
  thumb: string;
}

export interface Episode {
  id: string;
  title: string;
  duration: number;
  /** The episode video (the API's proxy). */
  media: string;
  poster: string;
  shots: Shot[];
}

/** One brand of the sample's starter catalog (`brands.json`), per market. */
export interface BrandMarket {
  product: string;
  url: string;
  /** Local brand name in this market when it differs from the line's name ("Mameiro Coffee"). */
  brand?: string;
  /** Starter photo file names in `web/public/brands/`: the product shot, an on-screen view, the brand's logo. */
  packshot?: string;
  screen?: string;
  logo?: string;
}

export interface Brand {
  id: string;
  name: string;
  category: string;
  placementTypes: string[];
  sceneAffinity: string[];
  exclusions: string[];
  markets: Record<string, BrandMarket>;
  /** Hue (0–360) for the generated logo mark. */
  hue: number;
  /** Generated SVG logo mark as a data URI (initial in a rounded square). */
  logo: string;
}

export type Surface = 'table' | 'wall' | 'street' | 'screen' | 'hand' | 'counter' | 'wardrobe';
export type MomentMode = 'replace' | 'insert' | 'blocked';
/** Scene group, from the scene type Gemini wrote. */
export type Scene = 'Café' | 'Street' | 'Apartment' | 'Shop';

/** One scene (= one shot) of the active episode, built from its detection output. */
export interface Moment {
  id: string;
  shotId: string;
  tIn: number;
  tOut: number;
  label: string;
  scene: Scene;
  surface: Surface;
  mode: MomentMode;
  tags: string[];
  keyframe: string;
}

/** A product placed in a box of a scene, for one audience (Watch). */
export interface Placement {
  /** `${boxId}:${productId}` */
  id: string;
  momentId: string;
  boxId: string;
  productId: string;
  /** What the box covers ("Café table"). */
  object: string;
  box: Box;
  /** Seconds in the episode while the scene is on screen. */
  tIn: number;
  tOut: number;
}
