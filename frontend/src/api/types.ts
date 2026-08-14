export interface Config {
  authMode: "oauth" | "dev";
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
