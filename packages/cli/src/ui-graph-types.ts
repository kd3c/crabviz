// Replicated minimal subset of webview-ui/src/graph/types.ts for CLI use
// We only need enough structure to feed convert/render pipeline.

export enum RelationKind {
  Call = 0,
  Impl = 1,
  Inherit = 2,
}

export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }

export interface Symbol {
  name: string;
  kind: number; // use numeric LSP SymbolKind
  range: Range; // selection range
  children: Symbol[];
}

export interface File {
  id: number;
  path: string;
  symbols: Symbol[];
}

export interface GlobalPosition {
  fileId: number;
  line: number;
  character: number;
}

export interface Relation {
  from: GlobalPosition;
  to: GlobalPosition;
  kind: RelationKind;
  provenance?: string; // e.g., 'static-py'
}

export interface Graph {
  files: File[];
  relations: Relation[];
  metrics?: Record<string, unknown>; // optional diagnostic / provenance metrics
}
