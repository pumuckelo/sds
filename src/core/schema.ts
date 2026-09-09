import { Schema } from "effect";

export const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{21}$/));
export const Ref = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{4,21}$/),
);
export const Title = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(240),
  Schema.isPattern(/\S/),
);
export const Text = Schema.String.check(Schema.isMaxLength(100_000));
export const Stage = Schema.Literals(["planning", "implementing", "reviewing"]);
export const Status = Schema.Literals([
  "queued",
  "active",
  "blocked",
  "done",
  "cancelled",
]);
export const TodoStatus = Schema.Literals(["pending", "done", "cancelled"]);
export const Severity = Schema.Literals(["low", "medium", "high", "critical"]);
export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Timestamp = Schema.String;
export const Todo = Schema.Struct({
  id: Id,
  title: Title,
  status: TodoStatus,
  stage: Schema.optional(Stage),
});
export const Finding = Schema.Struct({
  id: Id,
  description: Text,
  severity: Severity,
  status: Schema.Literals(["open", "resolved", "dismissed"]),
  file: Schema.optional(Title),
  line: Schema.optional(Revision),
  resolution: Schema.optional(Text),
});
export const Note = Schema.Struct({ id: Id, text: Text, createdAt: Timestamp });
export const Event = Schema.Struct({
  id: Id,
  revision: Revision,
  at: Timestamp,
  changes: Schema.Array(Schema.String),
});
export const Task = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Id,
  title: Title,
  description: Text,
  parentId: Schema.optional(Id),
  dependencyIds: Schema.optional(Schema.Array(Id)),
  stage: Stage,
  status: Status,
  blocker: Schema.optional(Text),
  revision: Revision,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  todos: Schema.Array(Todo),
  findings: Schema.Array(Finding),
  notes: Schema.Array(Note),
  history: Schema.Array(Event),
});
export type Task = typeof Task.Type;
export type Stage = typeof Stage.Type;
export type Status = typeof Status.Type;
export const Project = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Id,
  name: Title,
});
export const Checkout = Schema.Struct({
  id: Id,
  projectId: Id,
  name: Title,
  path: Schema.NonEmptyString,
});
export type Checkout = typeof Checkout.Type;
export const Registry = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  checkouts: Schema.Array(Checkout),
});

export const RegisterInput = Schema.Struct({
  path: Schema.NonEmptyString,
  name: Schema.optional(Title),
});
export const CreateInput = Schema.Struct({
  checkoutId: Ref,
  title: Title,
  description: Schema.optional(Text),
  parentId: Schema.optional(Ref),
  dependencyIds: Schema.optional(
    Schema.Array(Ref).check(Schema.isMaxLength(200)),
  ),
  verbose: Schema.optional(Schema.Boolean),
  todos: Schema.optional(
    Schema.Array(
      Schema.Struct({ title: Title, stage: Schema.optional(Stage) }),
    ).check(Schema.isMaxLength(200)),
  ),
});
export const Operation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("dependencies.set"),
    dependencyIds: Schema.Array(Ref).check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    type: Schema.Literal("parent.set"),
    parentId: Schema.NullOr(Ref),
  }),
  Schema.Struct({ type: Schema.Literal("title.set"), title: Title }),
  Schema.Struct({ type: Schema.Literal("description.set"), description: Text }),
  Schema.Struct({ type: Schema.Literal("stage.set"), stage: Stage }),
  Schema.Struct({
    type: Schema.Literal("status.set"),
    status: Status,
    reason: Schema.optional(Text),
  }),
  Schema.Struct({
    type: Schema.Literal("todo.add"),
    title: Title,
    stage: Schema.optional(Stage),
  }),
  Schema.Struct({
    type: Schema.Literal("todo.update"),
    todoId: Ref,
    title: Schema.optional(Title),
    status: Schema.optional(TodoStatus),
    stage: Schema.optional(Stage),
  }),
  Schema.Struct({
    type: Schema.Literal("todo.complete"),
    todoIds: Schema.Array(Ref).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(200),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("finding.add"),
    description: Schema.NonEmptyString.check(Schema.isMaxLength(100_000)),
    severity: Severity,
    file: Schema.optional(Title),
    line: Schema.optional(Revision),
  }),
  Schema.Struct({
    type: Schema.Literal("finding.resolve"),
    findingId: Ref,
    status: Schema.Literals(["resolved", "dismissed"]),
    resolution: Schema.NonEmptyString.check(Schema.isMaxLength(100_000)),
  }),
  Schema.Struct({
    type: Schema.Literal("note.add"),
    text: Schema.NonEmptyString.check(Schema.isMaxLength(100_000)),
  }),
]);
export const UpdateInput = Schema.Struct({
  checkoutId: Ref,
  taskId: Ref,
  expectedRevision: Revision,
  verbose: Schema.optional(Schema.Boolean),
  operations: Schema.Array(Operation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
  ),
});
export const GetInput = Schema.Struct({
  checkoutId: Ref,
  taskId: Ref,
  view: Schema.optional(Schema.Literals(["working", "full", "history"])),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
});
export const ListInput = Schema.Struct({
  checkoutId: Ref,
  parentId: Schema.optional(Schema.NullOr(Ref)),
  recursive: Schema.optional(Schema.Boolean),
  status: Schema.optional(Status),
  stage: Schema.optional(Stage),
  query: Schema.optional(Title),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
});
export const HeartbeatInput = Schema.Struct({
  checkoutId: Ref,
  taskId: Ref,
  agent: Title,
  running: Schema.Boolean,
});
export class SdsError extends Schema.TaggedError<SdsError>()("SdsError", {
  code: Schema.Literals([
    "INVALID_INPUT",
    "NOT_FOUND",
    "AMBIGUOUS_REF",
    "CONFLICT",
    "BUSY",
    "STORAGE_ERROR",
  ]),
  message: Schema.String,
}) {}
export type ErrorCode = SdsError["code"];

export const GetManyInput = Schema.Struct({
  checkoutId: Ref,
  taskIds: Schema.Array(Ref).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  view: GetInput.fields.view,
  offset: GetInput.fields.offset,
  limit: GetInput.fields.limit,
});
export const UpdateItem = Schema.Struct({
  taskId: Ref,
  expectedRevision: Revision,
  operations: UpdateInput.fields.operations,
});
export const UpdateManyBody = Schema.Struct({
  updates: Schema.Array(UpdateItem).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  verbose: Schema.optional(Schema.Boolean),
});
export const UpdateManyInput = Schema.Struct({
  checkoutId: Ref,
  ...UpdateManyBody.fields,
});
