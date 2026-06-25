//! LE-f32 BLOB codec.
//!
//! Matches the TypeScript storage format: `Buffer.from(Float32Array.buffer)` —
//! little-endian f32, no header, dimension-agnostic. A 768-dim vector produces
//! a 3072-byte BLOB (768 × 4 bytes).

/// Encode a slice of f32 values as a little-endian byte BLOB.
pub fn encode_f32_le(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Decode a little-endian f32 BLOB back to a `Vec<f32>`.
///
/// Returns `None` if `bytes.len()` is not a multiple of 4.
pub fn decode_f32_le(bytes: &[u8]) -> Option<Vec<f32>> {
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}
