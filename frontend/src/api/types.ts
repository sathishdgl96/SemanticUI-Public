export interface Config {
  authMode: "oauth" | "dev";
  directLoginMethods: ("externalbrowser" | "password" | "keypair")[];
}

export interface Me {
  snowflakeUser: string;
  snowflakeAccount: string;
  mode: string;
}

export interface SemanticViewSummary {
  name: string;
  database: string;
  schema: string;
  comment: string | null;
}

export interface FieldInfo {
  table: string;
  name: string;
  dataType: string | null;
}

export interface SemanticViewDetail {
  tables: { name: string }[];
  relationships: string[];
  dimensions: FieldInfo[];
  metrics: FieldInfo[];
  facts: FieldInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface QueryResponse {
  columns: ColumnInfo[];
  rows: unknown[][];
  truncated: boolean;
  sfqid: string | null;
  sql: string;
}

export interface SemanticQueryBody {
  database: string;
  schema: string;
  view: string;
  dimensions: string[];
  metrics: string[];
  orderBy?: { field: string; direction?: "asc" | "desc" }[];
  limit?: number;
}

export interface ViewRef {
  database: string;
  schema: string;
  name: string;
}

export interface VisualLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Visual {
  id: string;
  type: string;
  title: string;
  layout: VisualLayout;
  wells: Record<string, string[]>;
  options: Record<string, unknown>;
}

export interface CanvasSettings {
  columns: number;
  rowHeight: number;
}

export interface ReportDefinition {
  schemaVersion: number;
  name: string;
  view: ViewRef;
  canvas: CanvasSettings;
  visuals: Visual[];
}

export interface ReportSummary {
  id: string;
  name: string;
  view: ViewRef;
  updatedAt: string;
}

export type ReportDetail = ReportSummary & { definition: ReportDefinition };
