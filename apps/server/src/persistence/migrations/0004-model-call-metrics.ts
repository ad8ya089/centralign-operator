export const modelCallMetricsMigration = {
  version: 4, name: 'model-call-metrics',
  sql: `ALTER TABLE agent_model_calls ADD COLUMN metrics_json TEXT CHECK(metrics_json IS NULL OR (json_valid(metrics_json) AND json_type(metrics_json)='object'));`,
} as const;
