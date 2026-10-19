// Deliberate failure, to prove the CloudWatch alarms fire: one Batch job that logs an
// ERROR line and exits non-zero. Expect FailedJobAlarm and ErrorLinesAlarm to go to ALARM.
process ALWAYS_FAILS {
    container 'quay.io/biocontainers/samtools:1.24--h9dcdb79_1'

    script:
    """
    echo "ERROR: deliberate failure test (smoke/fail.nf)" >&2
    exit 1
    """
}

workflow {
    main:
    ALWAYS_FAILS()
}
