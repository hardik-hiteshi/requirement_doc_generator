/**
 * `@wdrg/config` holds the primitives every application uses to turn raw
 * environment variables into a validated, typed configuration object.
 *
 * It deliberately contains no application-specific keys: each app owns its own
 * schema and its own configuration module. This package only supplies the
 * coercion helpers and the fail-fast parser.
 */
export * from './env-schemas';
export * from './parse-env';
