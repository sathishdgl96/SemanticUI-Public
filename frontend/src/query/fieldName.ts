/**
 * The result column a field reference lands in.
 *
 * A reference names where a field lives; the query answers with the part
 * that identifies it *within* that source:
 *
 *     CUSTOMER.REGION            ->  REGION
 *     sales.ORDERS.REVENUE       ->  ORDERS.REVENUE   (a model's member)
 *     Customer 360.Customer      ->  Customer         (a shared dimension)
 *
 * "Everything after the first dot", not "the second segment". The two
 * agree for every `TABLE.FIELD` reference a single semantic view
 * produces, which is why this reads as a no-op there — but a model's
 * references carry a member alias in front, and taking the second segment
 * returned the member's TABLE instead of its field. Every chart then
 * looked for a column that was never in the result and drew "nothing to
 * chart for this field combination".
 *
 * One copy, because there were eight and they have to agree with what the
 * server names its columns.
 */
export function fieldName(ref: string): string {
  const dot = ref.indexOf(".");
  return dot === -1 ? ref : ref.slice(dot + 1);
}

/** Where that column sits in a result, or -1. Case-insensitive, because
 *  Snowflake answers in its own casing and a reference is written in the
 *  user's. */
export function columnIndexOf(
  columns: { name: string }[],
  ref: string,
): number {
  const name = fieldName(ref).toUpperCase();
  return columns.findIndex((column) => column.name.toUpperCase() === name);
}
