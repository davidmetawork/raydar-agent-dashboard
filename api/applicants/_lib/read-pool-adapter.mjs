// Core's pg-compatible readers pass serialized JSON as text and cast it in SQL.
// postgres.js otherwise infers json/jsonb from that cast and JSON.stringify's the
// string again. Bind strings explicitly as text so the server receives the exact
// request object, including generation, filters, cursor and application identity.
export function pgCompatibleReadClient(reserved) {
  return {
    async query(statement, parameters = []) {
      const bound = parameters.map(value => typeof value === 'string'
        ? reserved.typed(value, 25) : value);
      return { rows: await reserved.unsafe(statement, bound) };
    },
    release() { return reserved.release(); },
  };
}
