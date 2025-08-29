export type LanguageId = 'ts' | 'py';

export interface ProjectRoots { roots: string[]; }

export interface Edge {
  from: string;
  to: string;
  kind: 'import' | 'dynamic-import';
  lang: LanguageId;
}

export interface NodeInfo { id: string; lang: LanguageId; }

export interface BuildOptions { simplified: boolean; outFile: string; }

export interface GraphData { nodes: NodeInfo[]; edges: Edge[]; }
