/**
 * TaskChampion's sync operations and snapshots (taskchampion src/server/op.rs,
 * src/taskdb/sync.rs, src/taskdb/snapshot.rs, src/taskdb/apply.rs).
 *
 * A history segment is JSON, not compressed: {"operations":[{"Create":{"uuid"}}, {"Update":{…}}, …]}.
 * A snapshot is zlib-compressed JSON: {"<uuid>": {"<property>": "<value>"}, …}.
 * Inside this Worker an operation is {type: 'create'|'delete'|'update', uuid, property?, value?, timestamp?}.
 */
import { unzlibSync, zlibSync } from 'fflate';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function decodeSegment(bytes) {
  const { operations } = JSON.parse(decoder.decode(bytes));
  if (!Array.isArray(operations)) throw new Error('history segment has no operations');
  return operations.map((op) => {
    if (op.Create) return { type: 'create', uuid: op.Create.uuid };
    if (op.Delete) return { type: 'delete', uuid: op.Delete.uuid };
    if (op.Update) {
      const { uuid, property, value, timestamp } = op.Update;
      return { type: 'update', uuid, property, value: value ?? null, timestamp };
    }
    throw new Error(`unknown operation ${Object.keys(op)[0]}`);
  });
}

export function encodeSegment(ops) {
  const operations = ops.map((op) => {
    if (op.type === 'create') return { Create: { uuid: op.uuid } };
    if (op.type === 'delete') return { Delete: { uuid: op.uuid } };
    return { Update: { uuid: op.uuid, property: op.property, value: op.value ?? null, timestamp: op.timestamp } };
  });
  return encoder.encode(JSON.stringify({ operations }));
}

/**
 * Applies one operation to a Map of uuid → properties. Like taskchampion: creating an existing
 * task and deleting or updating a missing one change nothing, and a null value removes the property.
 * Returns true when something changed.
 */
export function applyOp(tasks, op) {
  if (op.type === 'create') {
    if (tasks.has(op.uuid)) return false;
    tasks.set(op.uuid, {});
    return true;
  }
  if (op.type === 'delete') return tasks.delete(op.uuid);
  const task = tasks.get(op.uuid);
  if (!task) return false;
  if (op.value === null) delete task[op.property];
  else task[op.property] = op.value;
  return true;
}

export function encodeSnapshot(tasks) {
  return zlibSync(encoder.encode(JSON.stringify(Object.fromEntries(tasks))));
}

export function decodeSnapshot(bytes) {
  return new Map(Object.entries(JSON.parse(decoder.decode(unzlibSync(bytes)))));
}
