import * as vscode from 'vscode';
import { extname } from "path";

const ICONS = [
	new vscode.ThemeIcon("symbol-file", new vscode.ThemeColor("symbolIcon.fileForeground")),
  new vscode.ThemeIcon("symbol-module", new vscode.ThemeColor("symbolIcon.moduleForeground")),
  new vscode.ThemeIcon("symbol-namespace", new vscode.ThemeColor("symbolIcon.namespaceForeground")),
  new vscode.ThemeIcon("symbol-package", new vscode.ThemeColor("symbolIcon.packageForeground")),
  new vscode.ThemeIcon("symbol-class", new vscode.ThemeColor("symbolIcon.classForeground")),
  new vscode.ThemeIcon("symbol-method", new vscode.ThemeColor("symbolIcon.methodForeground")),
  new vscode.ThemeIcon("symbol-property", new vscode.ThemeColor("symbolIcon.propertyForeground")),
  new vscode.ThemeIcon("symbol-field", new vscode.ThemeColor("symbolIcon.fieldForeground")),
  new vscode.ThemeIcon("symbol-constructor", new vscode.ThemeColor("symbolIcon.constructorForeground")),
  new vscode.ThemeIcon("symbol-enum", new vscode.ThemeColor("symbolIcon.enumeratorForeground")),
  new vscode.ThemeIcon("symbol-interface", new vscode.ThemeColor("symbolIcon.interfaceForeground")),
  new vscode.ThemeIcon("symbol-function", new vscode.ThemeColor("symbolIcon.functionForeground")),
  new vscode.ThemeIcon("symbol-variable", new vscode.ThemeColor("symbolIcon.variableForeground")),
  new vscode.ThemeIcon("symbol-constant", new vscode.ThemeColor("symbolIcon.constantForeground")),
  new vscode.ThemeIcon("symbol-string", new vscode.ThemeColor("symbolIcon.stringForeground")),
  new vscode.ThemeIcon("symbol-number", new vscode.ThemeColor("symbolIcon.numberForeground")),
  new vscode.ThemeIcon("symbol-boolean", new vscode.ThemeColor("symbolIcon.booleanForeground")),
  new vscode.ThemeIcon("symbol-array", new vscode.ThemeColor("symbolIcon.arrayForeground")),
  new vscode.ThemeIcon("symbol-object", new vscode.ThemeColor("symbolIcon.objectForeground")),
  new vscode.ThemeIcon("symbol-key", new vscode.ThemeColor("symbolIcon.keyForeground")),
  new vscode.ThemeIcon("symbol-null", new vscode.ThemeColor("symbolIcon.nullForeground")),
  new vscode.ThemeIcon("symbol-enummember", new vscode.ThemeColor("symbolIcon.enummemberForeground")),
  new vscode.ThemeIcon("symbol-struct", new vscode.ThemeColor("symbolIcon.structForeground")),
  new vscode.ThemeIcon("symbol-event", new vscode.ThemeColor("symbolIcon.eventForeground")),
  new vscode.ThemeIcon("symbol-operator", new vscode.ThemeColor("symbolIcon.operatorForeground")),
  new vscode.ThemeIcon("symbol-typeparameter", new vscode.ThemeColor("symbolIcon.typeparameterForeground")),
];

interface SearchFieldQuickPickItem extends vscode.QuickPickItem {
	id: string,
}

export class CallGraphPanel {
	public static readonly viewType = 'crabviz.callgraph';

	public static currentPanel: CallGraphPanel | null = null;
	private static num = 1;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	private svg: string | undefined;
	private focusMode = false;

	private quickpickItems: SearchFieldQuickPickItem[] | undefined;

	public constructor(extensionUri: vscode.Uri) {
		this._extensionUri = extensionUri;

		const panel = vscode.window.createWebviewPanel(CallGraphPanel.viewType, `Crabviz #${CallGraphPanel.num}`, vscode.ViewColumn.One, {
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'assets'),
				vscode.Uri.joinPath(this._extensionUri, 'out'),
			],
			enableScripts: true
		});

		panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon.svg');

		this._panel = panel;

		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'build quickpick items':
						const files = message.files.map((f: {id: string, name: string, path: string}) => {
							return { id: f.id, label: f.name, iconPath: ICONS[0], detail: f.path };
						});
						const symbols = message.symbols.map((s: {id: string, name: string, kind: number}) => {
							return { id: s.id, label: s.name, iconPath: ICONS[s.kind-1] };
						});
						this.quickpickItems = files.concat(symbols).sort((a: {id: string }, b: {id: string}) => {
							return a.id.localeCompare(b.id);
						});
						break;
					case 'search symbols':
						vscode.window.showQuickPick(this.quickpickItems!).then(item => {
							if (!item) { return; }
							this._panel.webview.postMessage({ command: 'select symbol', id: item.id, symbol: item.label});
						});
						break;
					case 'save':
						this.save();
						break;
					case 'save SVG':
						this.writeFile(vscode.Uri.from(message.uri), message.svg);
						break;
				}
			},
			null,
			this._disposables
		);

		this._panel.onDidChangeViewState(
			e => {
				if (panel.active) {
					CallGraphPanel.currentPanel = this;
				} else if (CallGraphPanel.currentPanel !== this) {
					return;
				} else {
					CallGraphPanel.currentPanel = null;
				}
			},
			null,
			this._disposables
		);

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		CallGraphPanel.num += 1;
	}

	public dispose() {
		if (CallGraphPanel.currentPanel === this) {
			CallGraphPanel.currentPanel = null;
		}

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	public async showCallGraph(svg: string, focusMode: boolean) {
		this.svg = svg;
		this.focusMode = focusMode;

		CallGraphPanel.currentPanel = this;

		this._panel.webview.html = await this.generateHTML(false);
	}

	async generateHTML(exported: boolean): Promise<string> {
		const nonce = getNonce();

		const resourceUri = vscode.Uri.joinPath(this._extensionUri, 'assets');

		const filePromises = ['variables.css', 'styles.css', 'graph.js', 'svg-pan-zoom.min.js'].map(fileName =>
			vscode.workspace.fs.readFile(vscode.Uri.joinPath(resourceUri, fileName))
		);

		const unexported = exported ? ["", ""] : [
			`<link rel="stylesheet" href="${this._panel.webview.asWebviewUri(vscode.Uri.joinPath(resourceUri, 'toolbar.css'))}">
			<script type="module" nonce="${nonce}" src="${this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'webview.js'))}"></script>`
			,
			`<div id="crabviz_toolbar">
				<vscode-text-field id="crabviz_search_field" readonly=true></vscode-text-field>
				<vscode-button>Go To Definition</vscode-button>
				<vscode-button id="crabviz_save_button">Save</vscode-button>
			</div>`];

		return Promise.all(filePromises).then(([cssVariables, cssStyles, ...scripts]) =>
			`<!DOCTYPE html>
			<html lang="en">
			<head>
					<meta charset="UTF-8">
					<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}';">
					<title>crabviz</title>
					<style id="crabviz_style">
						${cssVariables.toString()}
						${cssStyles.toString()}
					</style>
					<style id="edges-fading">
						g.edge:not(.selected, .incoming, .outgoing) {
							opacity: 0.05;
						}
					</style>
					${scripts.map((s) => `<script nonce="${nonce}">${s.toString()}</script>`).join('\n')}
			</head>
			<body data-vscode-context='{ "preventDefaultContextMenuItems": true }'>
					${unexported[1]}

					<div id="crabviz_svg">
					${this.svg!}
					</div>

					<script nonce="${nonce}">
						const graph = new CallGraph(document.querySelector("#crabviz_svg svg"), ${this.focusMode});
						graph.activate();

						svgPanZoom(graph.svg, {
							dblClickZoomEnabled: false,
						});
					</script>
					${unexported[0]}
			</body>
			</html>`
		);
	}

	save() {
		vscode.window.showSaveDialog({
			saveLabel: "Save",
			filters: {
				'HTML': ['html'],
				'SVG': ['svg'],
			}
		}).then(async (uri) => {
			if (uri) {
				switch (extname(uri.path)) {
					case '.html': {
						const html = await this.generateHTML(true);
						this.writeFile(uri, html);
						break;
					}
					case '.svg': {
						this._panel.webview.postMessage({ command: 'export SVG', uri: uri });
						break;
					}
					default: break;
				}
			}
		});
	}

	writeFile(uri: vscode.Uri, content: string) {
		vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'))
			.then(null, (reason : any) => {
				vscode.window.showErrorMessage(`Error on writing file: ${reason}`);
			});
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
