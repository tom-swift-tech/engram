//! Graph traversal helpers for WITH LINKS and FOLLOW LINKS modifiers.
//!
//! WITH LINKS fetches relation metadata for a set of chunks (post-query
//! decoration). FOLLOW LINKS performs a recursive CTE walk of the entity
//! graph to expand the result set with chunks attached to reached entities.

use aql_parser::ast::{FollowLinks, WithLinks};
use rusqlite::Connection;

use crate::error::AqlResult;
use crate::result::AqlLink;

/// Fetch link metadata for a set of chunk IDs.
///
/// For each chunk, walks chunk_entities → relations to find all edges
/// touching the chunk's entities (either as source or target).
pub fn fetch_links_for(
    conn: &Connection,
    chunk_ids: &[String],
    filter: &WithLinks,
) -> AqlResult<Vec<AqlLink>> {
    if chunk_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Validate link_type for injection safety if filter uses Type variant.
    // Kept as defense-in-depth alongside bound parameters below.
    if let WithLinks::Type { link_type } = filter {
        validate_identifier(link_type, "WITH LINKS TYPE")?;
    }

    let type_filter_clause = match filter {
        WithLinks::All => "",
        WithLinks::Type { .. } => " AND r.relation_type = ?",
    };

    let placeholders: Vec<&str> = chunk_ids.iter().map(|_| "?").collect();
    let sql = format!(
        "SELECT DISTINCT
             r.source_entity_id,
             r.target_entity_id,
             r.relation_type,
             r.confidence
         FROM relations r
         JOIN chunk_entities ce
           ON (ce.entity_id = r.source_entity_id OR ce.entity_id = r.target_entity_id)
         WHERE ce.chunk_id IN ({}) AND r.is_active = 1 {}",
        placeholders.join(", "),
        type_filter_clause
    );

    let mut params: Vec<rusqlite::types::Value> = chunk_ids
        .iter()
        .map(|s| rusqlite::types::Value::Text(s.clone()))
        .collect();
    if let WithLinks::Type { link_type } = filter {
        params.push(rusqlite::types::Value::Text(link_type.clone()));
    }

    let mut prepared = conn.prepare(&sql)?;
    let rows = prepared.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        Ok(AqlLink {
            source_id: row.get(0)?,
            target_id: row.get(1)?,
            link_type: row.get(2)?,
            confidence: row.get::<_, f64>(3).unwrap_or(0.0),
        })
    })?;

    let mut links = Vec::new();
    for r in rows {
        links.push(r?);
    }
    Ok(links)
}

/// Expand a set of chunk IDs by following a specific link type up to `depth`
/// hops. Returns the set of expanded chunk IDs (not including originals —
/// dedup is the caller's responsibility).
pub fn follow_links_expand(
    conn: &Connection,
    chunk_ids: &[String],
    follow: &FollowLinks,
) -> AqlResult<Vec<String>> {
    if chunk_ids.is_empty() {
        return Ok(Vec::new());
    }

    validate_identifier(&follow.link_type, "FOLLOW LINKS TYPE")?;

    let depth = follow.depth.unwrap_or(1).min(10) as i64;
    let placeholders: Vec<&str> = chunk_ids.iter().map(|_| "?").collect();

    let sql = format!(
        r#"
        WITH RECURSIVE graph_walk(entity_id, depth) AS (
            SELECT entity_id, 0
              FROM chunk_entities
             WHERE chunk_id IN ({})
            UNION
            SELECT r.target_entity_id, g.depth + 1
              FROM relations r
              JOIN graph_walk g ON r.source_entity_id = g.entity_id
             WHERE r.relation_type = ?
               AND r.is_active = 1
               AND g.depth < ?
        )
        SELECT DISTINCT c.id
          FROM chunks c
          JOIN chunk_entities ce ON c.id = ce.chunk_id
         WHERE ce.entity_id IN (SELECT entity_id FROM graph_walk WHERE depth > 0)
           AND c.is_active = 1
        "#,
        placeholders.join(", ")
    );

    let mut prepared = conn.prepare(&sql)?;
    let mut params: Vec<rusqlite::types::Value> = chunk_ids
        .iter()
        .map(|s| rusqlite::types::Value::Text(s.clone()))
        .collect();
    params.push(rusqlite::types::Value::Text(follow.link_type.clone()));
    params.push(rusqlite::types::Value::Integer(depth));

    let rows = prepared.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        row.get::<_, String>(0)
    })?;

    let mut ids = Vec::new();
    for r in rows {
        ids.push(r?);
    }
    Ok(ids)
}

/// Validate that an identifier (like a link_type) contains only safe characters
/// for interpolation into SQL. Prevents injection via the grammar's relation
/// name rules, which allow quotes and special chars inside string literals.
fn validate_identifier(ident: &str, context: &str) -> AqlResult<()> {
    // Allow alphanumerics, underscore, hyphen, and dot — matches AQL relation
    // type naming conventions. Rejects quotes, semicolons, SQL keywords, etc.
    if ident.is_empty() {
        return Err(crate::error::AqlError::InvalidQuery(format!(
            "{} link type cannot be empty",
            context
        )));
    }
    let safe = ident
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
    if !safe {
        return Err(crate::error::AqlError::InvalidQuery(format!(
            "{} contains unsafe characters: '{}'",
            context, ident
        )));
    }
    Ok(())
}
