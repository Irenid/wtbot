export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency должен быть положительным целым числом')
  }
  if (values.length === 0) return []

  const results = new Array<R>(values.length)
  let nextIndex = 0
  let firstError: unknown
  let failed = false
  const runner = async (): Promise<void> => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      try {
        results[index] = await mapper(values[index]!, index)
      } catch (error) {
        if (!failed) firstError = error
        failed = true
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runner()),
  )
  if (failed) throw firstError
  return results
}
