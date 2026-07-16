export async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
  return Promise.all(thunks.map((thunk) => thunk()));
}
