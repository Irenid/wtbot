# The offsite backup's image (offsite.sh): restic, which makes encrypted deduplicated snapshots, with
# rclone, its way to Google Drive, both from their official images.
FROM rclone/rclone:1.75.2 AS rclone

FROM restic/restic:0.19.1
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY offsite.sh /usr/local/bin/offsite
ENTRYPOINT ["/usr/local/bin/offsite"]
CMD ["run"]
