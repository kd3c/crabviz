declare module "viz.js" {
  export default class Viz {
    constructor(options?: any);
    renderString(dot: string): Promise<string>;
  }
}
declare module "viz.js/full.render.js" {
  export const Module: any;
  export const render: any;
  const _default: any; // allow default too
  export default _default;
}
declare module "viz.js/lite.render.js" {
  const render: any;
  export default render;
}
