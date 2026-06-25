//! Native `vec_distance_cosine(a_blob, b_blob)` scalar function.
//!
//! Computes cosine DISTANCE in [0, 2]:
//!   `1 - (a · b) / (‖a‖ · ‖b‖)`
//!
//! Uses the full formula — not a unit-norm shortcut — so results are
//! bit-compatible with `sqlite-vec`'s `vec_distance_cosine` for any input,
//! normalized or not. Dimension-agnostic: reads dim from BLOB length, never
//! hard-codes 768.
//!
//! Registering a scalar function on a `SQLITE_OPEN_READ_ONLY` connection is
//! allowed (scalar fns don't mutate the database; they execute during query
//! evaluation only). Phase 1 write-discipline is preserved.

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, Error, Result};

use crate::vector::codec::decode_f32_le;

/// Register `vec_distance_cosine(a_blob, b_blob) -> REAL` on `conn`.
///
/// The function is marked `SQLITE_DETERMINISTIC` so SQLite can cache results
/// and optimize subexpressions.
pub fn register_vec_distance_cosine(conn: &Connection) -> Result<()> {
    conn.create_scalar_function(
        "vec_distance_cosine",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            // Retrieve raw blob arguments. `as_blob()` returns `FromSqlError`
            // when the value is not a BLOB; `From<FromSqlError> for Error`
            // is implemented in rusqlite 0.31, so `?` converts automatically.
            let a_bytes = ctx.get_raw(0).as_blob()?;
            let b_bytes = ctx.get_raw(1).as_blob()?;

            let av = decode_f32_le(a_bytes).ok_or_else(|| {
                Error::UserFunctionError(
                    "vec_distance_cosine: operand a is not a valid LE-f32 blob".into(),
                )
            })?;
            let bv = decode_f32_le(b_bytes).ok_or_else(|| {
                Error::UserFunctionError(
                    "vec_distance_cosine: operand b is not a valid LE-f32 blob".into(),
                )
            })?;

            if av.len() != bv.len() {
                return Err(Error::UserFunctionError(
                    format!(
                        "vec_distance_cosine: vector dim mismatch: {} vs {}",
                        av.len(),
                        bv.len()
                    )
                    .into(),
                ));
            }

            // Full cosine distance formula. Accumulate in f64 to avoid
            // catastrophic cancellation on large (768-dim) vectors.
            let (mut dot, mut norm_a, mut norm_b) = (0_f64, 0_f64, 0_f64);
            for (&x, &y) in av.iter().zip(bv.iter()) {
                let (xf, yf) = (x as f64, y as f64);
                dot += xf * yf;
                norm_a += xf * xf;
                norm_b += yf * yf;
            }

            // If either vector is the zero vector, cosine distance is
            // undefined. Return 1.0 (maximum-ish distance) to match
            // `sqlite-vec`'s behaviour for zero-magnitude inputs.
            if norm_a == 0.0 || norm_b == 0.0 {
                return Ok(1.0_f64);
            }

            Ok(1.0 - dot / (norm_a.sqrt() * norm_b.sqrt()))
        },
    )
}
