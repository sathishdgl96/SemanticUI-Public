export interface AccountChoice {
  label: string;
  account: string;
}

export interface Config {
  authMode: "oauth" | "dev";
  directLoginMethods: ("externalbrowser" | "password" | "keypair")[];
  /** What the account dropdown may offer. Always at least one. */
  accounts: AccountChoice[];
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

/** One declared join, directed. `table` is the foreign-key side and
 *  `refTable` the primary-key side, so following one always moves from
 *  finer grain to coarser -- which is what makes the graph in joins.ts
 *  able to say whether two fields can be asked for together. */
export interface Relationship {
  name: string;
  table: string | null;
  refTable: string | null;
}

export interface SemanticViewDetail {
  tables: { name: string }[];
  relationships: Relationship[];
  dimensions: FieldInfo[];
  metrics: FieldInfo[];
  facts: FieldInfo[];
  /** Hierarchies the semantic model itself declares. Empty on every account
   *  seen so far -- reports define their own; see detect_hierarchies. */
  modelHierarchies?: Hierarchy[];
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
  /** Set when the selected entities had no join path of their own and the
   *  query was routed through a third. Rows are then limited to combinations
   *  that occur there, which the UI says out loud rather than leaving the
   *  reader to wonder why a pair is missing. */
  bridgedThrough?: string | null;
}

export interface SemanticQueryBody {
  database: string;
  schema: string;
  view: string;
  dimensions: string[];
  metrics: string[];
  filters?: Filter[];
  orderBy?: { field: string; direction?: "asc" | "desc" }[];
  limit?: number;
}

export interface IsFilter {
  id: string;
  field: string;
  op: "is" | "isNot";
  values: string[];
}

export interface TextFilter {
  id: string;
  field: string;
  op: "contains" | "notContains" | "startsWith" | "endsWith";
  value: string;
}

export interface CompareFilter {
  id: string;
  field: string;
  op: "gt" | "gte" | "lt" | "lte";
  value: string | number;
}

/** Presence tests. No value by design — see BlankFilter in filters.py. */
export interface BlankFilter {
  id: string;
  field: string;
  op: "isBlank" | "isNotBlank";
}

export interface BetweenFilter {
  id: string;
  field: string;
  op: "between" | "notBetween";
  from: string | number;
  to: string | number;
}

export interface RelativeDateFilter {
  id: string;
  field: string;
  op: "relativeDate";
  unit?: "day" | "month" | "year";
  count?: number;
  preset?: "monthToDate" | "yearToDate";
}

/** Mirrors the discriminated union in backend/app/reports/filters.py. */
export type Filter =
  | IsFilter
  | TextFilter
  | CompareFilter
  | BlankFilter
  | BetweenFilter
  | RelativeDateFilter;

export interface Hierarchy {
  id: string;
  name: string;
  levels: string[];
}

export interface FieldValuesResponse {
  values: string[];
  truncated: boolean;
}

export type Role = "viewer" | "editor" | "admin";

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: "personal" | "shared";
  myRole: Role;
  memberCount: number;
  reportCount: number;
}

export interface WorkspaceMember {
  userId: string;
  snowflakeUser: string;
  role: Role;
  isMe: boolean;
}

export interface SheetRequest {
  title: string;
  dimensions: string[];
  metrics: string[];
  filters: Filter[];
  orderBy: { field: string; direction: "asc" | "desc" }[];
  /** Free text describing drill position or cross-filter. Recorded on the
   *  workbook's Summary sheet so the file explains itself later. */
  context: string;
}

export interface ConnectResponse {
  account: string;
  database: string;
  schema: string;
  view: string;
  sheets: { title: string; sql: string }[];
}

export interface AskSpec {
  dimensions: string[];
  metrics: string[];
  filters: Filter[];
  orderBy: { field: string; direction: "asc" | "desc" }[];
  limit: number | null;
  explanation: string;
}

export interface AskResponse {
  explanation: string;
  spec: AskSpec;
  columns: ColumnInfo[];
  rows: unknown[][];
  truncated: boolean;
  /** Returned on purpose: an answer you cannot audit is one you should not
   *  act on. The panel shows it alongside the numbers. */
  sql: string;
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
  filters: Filter[];
}

export interface CanvasSettings {
  columns: number;
  rowHeight: number;
  /** `#rgb` or `#rrggbb`. Absent means the product's own canvas grey. The
   *  server enforces the pattern; these values reach a `style` attribute. */
  background?: string | null;
}

export interface Page {
  id: string;
  name: string;
  /** "canvas" is the tile grid; "sheet" is the Excel-like page holding one
   *  full-bleed pivot (matrix or table). Absent means canvas. */
  kind?: "canvas" | "sheet";
  visuals: Visual[];
  /** The page scope: applies to every visual on this page. */
  filters: Filter[];
}

export interface ReportDefinition {
  schemaVersion: number;
  name: string;
  view: ViewRef;
  canvas: CanvasSettings;
  pages: Page[];
  /** The all-pages scope. Page and visual scopes live on their owners. */
  filters: Filter[];
  hierarchies: Hierarchy[];
}

export interface ReportSummary {
  id: string;
  name: string;
  view: ViewRef;
  updatedAt: string;
  workspaceId: string;
  workspaceName: string;
  /** The caller's role in that workspace, so the UI can disable an action
   *  with a stated reason rather than letting them discover it on a 403. */
  myRole: Role;
  /** Pinned by THIS caller. Per-user, so it is part of the summary rather
   *  than of the report. */
  favorite: boolean;
  /** When this caller last opened it, or null if they never have. */
  lastViewedAt: string | null;
}

export type ReportDetail = ReportSummary & { definition: ReportDefinition };

/** A saved explore: a saved QUERY, not a canvas. Mirrors
 *  backend/app/explores/schema.py. */
export interface ExploreDefinition {
  schemaVersion: number;
  name: string;
  view: ViewRef;
  dimensions: string[];
  metrics: string[];
  filters: Filter[];
  orderBy: { field: string; direction: "asc" | "desc" }[];
  limit?: number | null;
}

export interface ExploreSummary {
  id: string;
  name: string;
  view: ViewRef;
  updatedAt: string;
  workspaceId: string;
  workspaceName: string;
  myRole: Role;
  favorite: boolean;
  lastViewedAt: string | null;
}

export type ExploreDetail = ExploreSummary & { definition: ExploreDefinition };
