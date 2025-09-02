// Ported from webview-ui/src/graph/render.ts for CLI parity
import { instance as vizInstance } from '@viz-js/viz';

const namespaceURI = 'http://www.w3.org/2000/svg';

export async function renderAndTransform(dot:string, focus:string|null): Promise<SVGSVGElement> {
  const viz = await vizInstance();
  const svg = viz.renderSVGElement(dot) as unknown as SVGSVGElement;
  applyTransform(svg, focus);
  return svg;
}

export function applyTransform(svg: SVGSVGElement, focus:string|null){
  svg.classList.add('callgraph');
  svg.querySelectorAll('title').forEach(el=> el.remove());
  // unwrap anchors, classify cells
  svg.querySelectorAll<SVGAElement>('a').forEach(a=> {
    const href = a.getAttribute('xlink:href') || a.getAttribute('href') || a.href?.baseVal || '';
    const parent = a.parentNode as SVGElement;
    a.replaceWith(...Array.from(a.childNodes));
    if (parent.id) parent.id = parent.id.replace(/^a_/, '');
    const kind = parseInt(href);
    if (Number.isNaN(kind)) {
      parent.classList.add('title');
      const rawFull = parent.getAttribute('DATA-FULLPATH') || parent.getAttribute('data-fullpath') || href;
      const node = parent.closest('.node');
      if (node) {
        node.setAttribute('data-path', rawFull);
        node.setAttribute('data-filename', rawFull.split(/[/\\]/).pop()||'');
      }
    } else {
      parent.setAttribute('data-kind', String(kind));
      parent.classList.add('cell');
      switch (kind) {
        case 12: parent.classList.add('function'); break; // Function
        case 6: parent.classList.add('method'); break;    // Method
        case 9: parent.classList.add('constructor'); break; // Constructor
        case 5: parent.classList.add('class'); break; // Class
        default: break;
      }
    }
  });
  // replace node polygons with rect
  svg.querySelectorAll<SVGPolygonElement>('g.node polygon').forEach(poly=> {
    const p0 = poly.points[0]; const p2 = poly.points[2];
    const rect = document.createElementNS(namespaceURI,'rect');
    rect.setAttribute('x', String(Math.min(p0.x,p2.x)));
    rect.setAttribute('y', String(Math.min(p0.y,p2.y)));
    rect.setAttribute('width', String(Math.abs(p0.x-p2.x)));
    rect.setAttribute('height', String(Math.abs(p0.y-p2.y)));
    poly.parentNode?.replaceChild(rect, poly);
  });
  // cluster title polygons (except first) to rect with label class
  svg.querySelectorAll<SVGPolygonElement>('g.cluster > polygon:not(:first-of-type)').forEach(poly=> {
    const p0 = poly.points[0]; const p2 = poly.points[2];
    const rect = document.createElementNS(namespaceURI,'rect');
    rect.classList.add('cluster-label');
    rect.setAttribute('x', String(Math.min(p0.x,p2.x)));
    rect.setAttribute('y', String(Math.min(p0.y,p2.y)));
    rect.setAttribute('width', String(Math.abs(p0.x-p2.x)));
    rect.setAttribute('height', String(Math.abs(p0.y-p2.y)));
    poly.parentNode?.replaceChild(rect, poly);
  });
  // Edge dataset + hover path duplication
  svg.querySelectorAll<SVGGElement>('g.edge').forEach(edge=> {
    const id = edge.id; // expected pattern tail:port-head:port
    if (id.includes('-')) {
      const [fromCell, toCell] = id.split('-');
      edge.setAttribute('data-from', fromCell);
      edge.setAttribute('data-to', toCell);
    }
    edge.querySelectorAll('path').forEach(path=> {
      const clone = path.cloneNode() as SVGPathElement;
      clone.classList.add('hover-path');
      clone.removeAttribute('stroke-dasharray');
      path.parentNode?.appendChild(clone);
    });
  });
  // Faded layer
  if (!svg.getElementById('faded-group')) {
    const faded = document.createElementNS(namespaceURI,'g');
    faded.id = 'faded-group';
    svg.getElementById('graph0')?.appendChild(faded);
  }
  // defs (shadow + gradient) if missing
  if (!svg.querySelector('defs #shadow')) {
    const defs = document.createElementNS(namespaceURI,'defs');
    defs.innerHTML = `<filter id="shadow"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-opacity="0.5"></feDropShadow></filter>
<linearGradient id="highlightGradient"><stop offset="0%" stop-color="var(--edge-incoming-color)"/><stop offset="100%" stop-color="var(--edge-outgoing-color)"/></linearGradient>`;
    svg.appendChild(defs);
  }
  if (focus) {
    const fEl = svg.getElementById(focus);
    if (fEl) fEl.classList.add('highlight');
  }
  // Remove any residual href/xlink:href attributes to avoid default browser navigation
  svg.querySelectorAll('[href],[xlink\\:href]').forEach(el=> { try { (el as Element).removeAttribute('href'); (el as Element).removeAttribute('xlink:href'); } catch {} });
}
