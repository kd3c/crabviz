export interface Graph {
  files: File[];
  relations: Relation[];
}

export interface File {
  id: number;
  path: string;
  symbols: Symbol[];
}

export interface Relation {
  from: GlobalPosition;
  to: GlobalPosition;
  kind: RelationKind;
}

export interface Symbol {
  name: string;
  kind: SymbolKind;
  range: Range;
  children: Symbol[];
}

export enum SymbolKind {
  File = 1,

  Module,
  Namespace,
  Package,
  Class,
  Method,
  Property,
  Field,
  Constructor,
  Enum,
  Interface,
  Function,
  Variable,
  Constant,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Key,
  Null,
  EnumMember,
  Struct,
  Event,
  Operator,
  TypeParameter,
}

export enum RelationKind {
  Call,
  Impl,
  Inherit,
}

export interface GlobalPosition {
  file_id: number;
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Position {
  line: number;
  character: number;
}
