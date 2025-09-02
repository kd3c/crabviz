// Lightweight interaction layer for exported Crabviz HTML graphs.
// Features: pan (drag background), zoom (ctrl+wheel), node/cell selection, edge highlighting,
// fade non-selected nodes, VS Code navigation messages.

class InlineCallGraph {
  svg: SVGSVGElement;
  root: SVGGElement | null;
  scale = 1;
  panX = 0;
  panY = 0;
  dragging = false;
  lastClientX = 0;
  lastClientY = 0;
  edges: SVGGElement[] = [];

  constructor(svg: SVGSVGElement){
    this.svg = svg;
    this.root = svg.querySelector('#graph0');
    this.edges = Array.from(svg.querySelectorAll('g.edge')) as SVGGElement[];
    this.initPanZoom();
    this.bindClicks();
  }

  initPanZoom(){
    if(!this.root) return;
    const svg = this.svg;
    svg.addEventListener('wheel', e=> {
      if(!e.ctrlKey) return; e.preventDefault();
      const ds = Math.exp(-e.deltaY*0.001);
      const rect = svg.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      this.panX = cx - (cx - this.panX)*ds;
      this.panY = cy - (cy - this.panY)*ds;
      this.scale *= ds;
      this.apply();
    }, { passive:false });
    svg.addEventListener('mousedown', e=> {
      if(e.button!==0) return;
      this.dragging = true;
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;
    });
    window.addEventListener('mouseup', ()=> { this.dragging=false; });
    window.addEventListener('mousemove', e=> {
      if(!this.dragging) return;
      this.panX += e.clientX - this.lastClientX;
      this.panY += e.clientY - this.lastClientY;
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;
      this.apply();
    });
  }

  apply(){
    if(!this.root) return;
    this.root.setAttribute('transform', `matrix(${this.scale} 0 0 ${this.scale} ${this.panX} ${this.panY})`);
  }

  bindClicks(){
    this.svg.addEventListener('click', e=> {
      let el: any = e.target;
      while(el && el instanceof SVGElement && !el.classList.contains('cell') && !el.classList.contains('node') && !el.classList.contains('edge')) el = el.parentNode;
      if(!el) return;
      e.preventDefault();
      this.clearSelection();
      if (el.classList.contains('cell')) this.selectCell(el);
      else if (el.classList.contains('node')) this.selectNode(el);
      else if (el.classList.contains('edge')) el.classList.add('selected');
    });
  }

  clearSelection(){
    this.svg.querySelectorAll('.selected').forEach(e=> e.classList.remove('selected'));
    const faded = this.svg.getElementById('faded-group');
    if (faded && this.root) { [...faded.children].forEach(c=> this.root!.appendChild(c)); }
    this.edges.forEach(e=> e.classList.remove('incoming','outgoing'));
  }

  selectNode(node: SVGGElement){
    node.classList.add('selected');
    const id = node.id;
    this.highlightEdges(ed=> [ ed.dataset.to?.startsWith(id+':')||false, ed.dataset.from?.startsWith(id+':')||false ]);
    this.fadeAllExcept(new Set([id]));
  }

  selectCell(cell: SVGGElement){
    cell.classList.add('selected');
    const node = cell.closest('.node') as SVGGElement | null;
    if (node) this.fadeAllExcept(new Set([node.id]));
    this.highlightEdges(ed=> [ ed.dataset.to===cell.id, ed.dataset.from===cell.id ]);
    this.navigate(cell);
  }

  fadeAllExcept(keep:Set<string>){
    if(!this.root) return;
    let faded = this.svg.getElementById('faded-group');
    if(!faded){ faded = document.createElementNS('http://www.w3.org/2000/svg','g'); faded.id='faded-group'; this.root.appendChild(faded); }
    this.root.querySelectorAll(':scope > g.node').forEach(n=> { if(!keep.has(n.id)) faded!.appendChild(n); });
  }

  highlightEdges(test:(e:SVGGElement)=>[boolean,boolean]){
    this.edges.forEach(e=> { const [inc,out] = test(e); if(inc) e.classList.add('incoming'); if(out) e.classList.add('outgoing'); });
  }

  navigate(cell: SVGGElement){
    try {
      const node = cell.closest('.node');
      const filePath = node?.getAttribute('data-path');
      if(!filePath) return;
      const m = /(\d+):(\d+)_(\d+)$/.exec(cell.id); if(!m) return;
      const line = Number(m[2]); const ch = Number(m[3]);
      if (typeof (globalThis as any).acquireVsCodeApi === 'function') {
        (globalThis as any).acquireVsCodeApi().postMessage({ command:'go to definition', path:filePath, ln:line, col:ch });
      }
    } catch {}
  }
}

(globalThis as any).CallGraph = InlineCallGraph;
export {};
