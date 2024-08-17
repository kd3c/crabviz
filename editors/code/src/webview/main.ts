import { provideVSCodeDesignSystem, vsCodeButton, Button, vsCodeTextField, TextField } from "@vscode/webview-ui-toolkit";

provideVSCodeDesignSystem().register(vsCodeButton(), vsCodeTextField());


const vscode = acquireVsCodeApi();
const searchField = document.getElementById('crabviz_search_field') as TextField;
const gotoButton = document.getElementById('crabviz_goto_button') as Button;
const saveButton = document.getElementById('crabviz_save_button') as Button;

window.addEventListener('load', main);
window.addEventListener('message', (e) => {
  const message = e.data;

  switch (message.command) {
    case 'export SVG':
      exportSVG(message.uri);
      break;
    case 'deselect symbol':
      searchField.value = '';
      gotoButton.disabled = true;
      break;
    case 'select symbol':
      searchField.value = message.symbol;
      gotoButton.disabled = false;

      if (e.source) {
        const elem = document.getElementById(message.id);
        const initDict = { clientX: elem?.offsetLeft, clientY: elem?.offsetTop, bubbles: true };
        elem?.dispatchEvent(new MouseEvent('mousedown', initDict));;
        elem?.dispatchEvent(new MouseEvent('mouseup', initDict));;
      }

      break;
  }
});

function main() {
  const files = Array.from(
    <NodeListOf<HTMLElement>>document.querySelectorAll('#crabviz_svg g.title'),
    (t) => {
      return { id: t.dataset.file_id!, path: t.dataset.path, name: t.firstElementChild?.textContent };
    }
  );
  const symbols = Array.from(
    <NodeListOf<HTMLElement>>document.querySelectorAll('#crabviz_svg g.cell'),
    (cell) => {
      return { id: cell.id, name: cell.querySelector(":scope > text:last-of-type")?.textContent, kind: cell.dataset.kind! };
    }
  );
  vscode.postMessage({
    command: "build quickpick items",
    files,
    symbols,
  });


  searchField.addEventListener('focus', (e) => {
    vscode.postMessage({
      command: "search symbols",
    });
  });

  saveButton.addEventListener('click', () => {
    vscode.postMessage({
      command: 'save',
    });
  });
}

function exportSVG(uri: any) {
  const svg = <SVGSVGElement>document.querySelector('#crabviz_svg svg')!.cloneNode(true);
  const viewport = svg.querySelector(':scope > g')!;
  const graph = viewport.querySelector(':scope > g')!;

  svg.replaceChild(graph, viewport);

  svg.appendChild(document.getElementById('crabviz_style')!.cloneNode(true));
  svg.insertAdjacentHTML(
    "beforeend",
    "<style>* { pointer-events: none; }</style>"
  );

  vscode.postMessage({
    command: 'save SVG',
    uri: uri,
    svg: svg.outerHTML.replaceAll("&nbsp;", "&#160;")
  });
}


