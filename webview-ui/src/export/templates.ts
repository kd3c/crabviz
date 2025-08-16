import cssSvgStyle from "../assets/out/index.css?raw";
import jsCallGraph from "../assets/out/index.js?raw";

export function svg(svgContent: string, width: number, height: number): string {
  return `
<svg class="callgraph" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}">
  <style>${cssSvgStyle}</style>
  ${svgContent}
</svg>`;
}

export function html(
  svgContent: string,
  width: number,
  height: number,
  focus: string | null,
): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;

      background: var(--background-color);
    }
    ${cssSvgStyle}
  </style>
</head>
<body>
  <svg class="callgraph" viewBox="0 0 ${width} ${height}">
    ${svgContent}
  </svg>

  <script type="module">
    ${jsCallGraph}

    const graph = new CallGraph(document.querySelector(".callgraph"), ${focus});
    graph.setUpPanZoom();
  </script>
</body>
</html>`;
}
