/*
 * erg's SIMD search kernel, compiled to WebAssembly by scripts/kernels.mjs
 * (clang --target=wasm32 -msimd128). It finds candidate starts for a set of
 * short literals (Teddy, as in ripgrep) or for a sequence of byte sets.
 *
 * Each of up to three consecutive positions has two 16-byte tables, indexed
 * by a byte's low and high nibble; a byte b "hits" bucket k at position j
 * when bit k is set in both lo_j[b & 15] and hi_j[b >> 4]. Buckets are
 * literals (or groups of them), or, for a sequence, the bytes of one set.
 * With `buckets`, a start is a candidate when one bucket hits at every
 * position (Teddy); without, when any bucket does at each. Candidates are
 * checked by the caller.
 */
#include <stdint.h>
#include <wasm_simd128.h>

static inline v128_t hits(const uint8_t *t, int j, v128_t v) {
  v128_t lo = wasm_v128_and(v, wasm_i8x16_splat(0x0f));
  v128_t hi = wasm_u8x16_shr(v, 4);
  return wasm_v128_and(wasm_i8x16_swizzle(wasm_v128_load(t + 32 * j), lo),
                       wasm_i8x16_swizzle(wasm_v128_load(t + 32 * j + 16), hi));
}

static inline int one(const uint8_t *in, int32_t i, const uint8_t *t, int m, int buckets) {
  uint8_t acc = 0xff;
  for (int j = 0; j < m; j++) {
    uint8_t b = in[i + j];
    uint8_t r = t[32 * j + (b & 15)] & t[32 * j + 16 + (b >> 4)];
    acc &= buckets ? r : (r ? 0xff : 0);
  }
  return acc != 0;
}

#define KERNEL(NAME, M, BUCKETS)                                                       \
  static int32_t NAME(const uint8_t *in, int32_t from, int32_t end, const uint8_t *t) { \
    int32_t i = from;                                                                  \
    for (; i + 16 <= end; i += 16) {                                                   \
      v128_t acc = wasm_i8x16_splat(-1);                                               \
      for (int j = 0; j < M; j++) {                                                    \
        v128_t r = hits(t, j, wasm_v128_load(in + i + j));                             \
        acc = wasm_v128_and(acc, BUCKETS ? r : wasm_i8x16_ne(r, wasm_i8x16_splat(0))); \
      }                                                                                \
      uint32_t mask = wasm_i8x16_bitmask(wasm_i8x16_ne(acc, wasm_i8x16_splat(0)));      \
      if (mask) return i + __builtin_ctz(mask);                                        \
    }                                                                                  \
    for (; i < end; i++)                                                               \
      if (one(in, i, t, M, BUCKETS)) return i;                                         \
    return -1;                                                                         \
  }

KERNEL(b1, 1, 1)
KERNEL(b2, 2, 1)
KERNEL(b3, 3, 1)
KERNEL(s1, 1, 0)
KERNEL(s2, 2, 0)
KERNEL(s3, 3, 0)

/*
 * The first candidate start in [from, end) of the input at `in`, for the m
 * positions' tables at `t`; -1 if there is none. Every position of a start
 * before `end` must be readable: end <= length - m + 1.
 */
__attribute__((export_name("find"))) int32_t find(const uint8_t *in, int32_t from, int32_t end,
                                                  const uint8_t *t, int32_t m, int32_t buckets) {
  if (buckets) return m == 1 ? b1(in, from, end, t) : m == 2 ? b2(in, from, end, t) : b3(in, from, end, t);
  return m == 1 ? s1(in, from, end, t) : m == 2 ? s2(in, from, end, t) : s3(in, from, end, t);
}
