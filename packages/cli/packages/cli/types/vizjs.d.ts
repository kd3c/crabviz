declare module "viz.js" {
  export default class Viz {
    constructor(options?: any);
    renderString(dot: string): Promise<string>;
  }
}

declare module "viz.js/full.render.js" {
  const render: any;
  export default render;
}
