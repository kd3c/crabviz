import * as vscode from 'vscode';
import { extname } from "path";

export class CallGraphPanel {
	public static readonly viewType = 'crabviz.callgraph';

	public static currentPanel: CallGraphPanel | null = null;
	private static num = 1;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	private graph: any | undefined;

	public constructor(extensionUri: vscode.Uri) {
		this._extensionUri = extensionUri;

		const panel = vscode.window.createWebviewPanel(CallGraphPanel.viewType, `Crabviz #${CallGraphPanel.num}`, vscode.ViewColumn.One, {
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'out'),
			],
			enableScripts: true
		});

		panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon.svg');

		this._panel = panel;

		this._panel.webview.onDidReceiveMessage(
			msg => {
				switch (msg.command) {
					case 'save':
						this.save();
						break;
					case 'save SVG':
						this.writeFile(vscode.Uri.from(msg.uri), msg.svg);
						break;
					case 'go to definition':
						vscode.workspace.openTextDocument(vscode.Uri.file(msg.path))
							.then(doc => vscode.window.showTextDocument(doc))
							.then(editor => {
								let position = new vscode.Position(msg.ln, msg.col);
								let range = new vscode.Range(position, position);
								editor.selection = new vscode.Selection(position, position);
								editor.revealRange(range);
							});
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

	public async showCallGraph(graph: any) {
		this.graph = graph;

		CallGraphPanel.currentPanel = this;

		this._panel.webview.html = await this.generateHTML();
	}

	async generateHTML(): Promise<string> {
		const nonce = getNonce();

		const webview = this._panel.webview;
		const assetsUri = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview-ui');
		const cssUri = vscode.Uri.joinPath(assetsUri, "index.css");
		const jsUri = vscode.Uri.joinPath(assetsUri, "index.js");

		return Promise.resolve(`
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src ${webview.cspSource};">
				<script nonce="${nonce}">
					const vscode = acquireVsCodeApi();

					document.crabvizProps = {
						graph: ${JSON.stringify(this.graph)},
					};

					window.addEventListener(
						"message",
						(e) => {
							vscode.postMessage(e.data);
						}
					);
				</script>
				<link rel="stylesheet" href="${webview.asWebviewUri(cssUri)}" />
				<script nonce="${nonce}" type="module" src="${webview.asWebviewUri(jsUri)}"></script>
			</head>
			<body data-vscode-context='{ "preventDefaultContextMenuItems": true }'>
				<div id="root"></div>
			</body>
			</html>
		`);
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
						const html = await this.generateHTML();
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
