export async function pipeline<T>(
  items: T[],
  ...stages: Array<(item: T, index: number) => Promise<T>>
): Promise<T[]> {
  return Promise.all(items.map(async (initial, index) => {
    let item = initial;
    for (const stage of stages) item = await stage(item, index);
    return item;
  }));
}
