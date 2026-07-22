"""
Managed Flink (KDA) troubleshooting DEMO application.

Purpose: intentionally produce a "restart storm" so learners can practice
reading CloudWatch Logs. The app uses Flink's built-in `datagen` source and
`blackhole` sink (no external Kinesis/S3 needed) and a Python UDF that throws
an unhandled exception on some rows -> the job fails and Managed Flink restarts
it from the latest checkpoint, over and over.

Runtime properties (property group "FlinkAppProperties"):
  - fail_mode       : "true" | "false"  (default true)  -> whether the UDF throws
  - rows_per_second : datagen rate       (default "5")
  - fail_on_risk    : throw when risk == this int (default "7")

Set fail_mode=false to demonstrate a HEALTHY application for comparison.
"""
import json
import logging
import os

from pyflink.table import EnvironmentSettings, TableEnvironment, DataTypes
from pyflink.table.udf import udf

logging.basicConfig(level=logging.INFO)
LOG = logging.getLogger("DemoFlinkApp")

APPLICATION_PROPERTIES_FILE_PATH = "/etc/flink/application_properties.json"


def load_application_properties():
    """Read runtime properties injected by Managed Flink. Empty when running locally."""
    if os.path.isfile(APPLICATION_PROPERTIES_FILE_PATH):
        with open(APPLICATION_PROPERTIES_FILE_PATH, "r") as f:
            return json.load(f)
    LOG.warning("Properties file not found (%s). Assuming LOCAL run.",
                APPLICATION_PROPERTIES_FILE_PATH)
    return None


def get_property_group(props, group_id):
    if props is None:
        return {}
    for group in props:
        if group.get("PropertyGroupId") == group_id:
            return group.get("PropertyMap", {})
    return {}


def main():
    props = load_application_properties()
    is_local = props is None

    app_props = get_property_group(props, "FlinkAppProperties")
    fail_mode = app_props.get("fail_mode", "true").lower() == "true"
    rows_per_second = app_props.get("rows_per_second", "5")
    fail_on_risk = int(app_props.get("fail_on_risk", "7"))

    LOG.info("Starting DemoFlinkApp fail_mode=%s rows_per_second=%s fail_on_risk=%s",
             fail_mode, rows_per_second, fail_on_risk)

    settings = EnvironmentSettings.in_streaming_mode()
    t_env = TableEnvironment.create(settings)

    # ---- Source: built-in datagen (no external dependency) ----
    t_env.execute_sql(f"""
        CREATE TABLE orders (
            order_id BIGINT,
            country  STRING,
            risk     INT,
            amount   DOUBLE
        ) WITH (
            'connector' = 'datagen',
            'rows-per-second' = '{rows_per_second}',
            'fields.country.length' = '3',
            'fields.risk.min' = '0',
            'fields.risk.max' = '9',
            'fields.amount.min' = '1.0',
            'fields.amount.max' = '500.0'
        )
    """)

    # ---- Sink: built-in blackhole (discards rows) ----
    t_env.execute_sql("""
        CREATE TABLE sink (
            order_id     BIGINT,
            country_norm STRING,
            amount       DOUBLE
        ) WITH (
            'connector' = 'blackhole'
        )
    """)

    # ---- UDF with an INTENTIONAL bug to trigger restarts ----
    @udf(result_type=DataTypes.STRING())
    def enrich_country(country, risk):
        LOG.info("Enriching order country=%s risk=%s", country, risk)
        if fail_mode and risk == fail_on_risk:
            # Unhandled exception -> operator fails -> job restarts from checkpoint.
            # This mirrors a real-world NullPointerException in an enrichment operator.
            # FIX (demo step 5, way B): replace the raise below with
            #   LOG.warning("Enrichment lookup failed for country=%s risk=%s, using fallback", country, risk)
            #   return "unknown"
            raise ValueError(
                f"Unhandled enrichment error: downstream lookup failed for country={country} (risk={risk})"
            )
        return country.lower() if country is not None else "unknown"

    t_env.create_temporary_function("enrich_country", enrich_country)

    result = t_env.execute_sql("""
        INSERT INTO sink
        SELECT order_id, enrich_country(country, risk), amount
        FROM orders
    """)

    # On the Managed Flink cluster the job is submitted and runs detached.
    # Locally, block so you can observe output.
    if is_local:
        result.wait()


if __name__ == "__main__":
    main()
