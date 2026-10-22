//! Go time layouts used in CLI output, rendered with jiff. Unix times are
//! shown in the local zone, matching Go's `time.Unix(...).Format(...)`.

use jiff::tz::TimeZone;
use jiff::{Timestamp, Zoned};

/// Go's "2006-01-02 15:04:05".
const DATE_TIME: &str = "%Y-%m-%d %H:%M:%S";
/// Go's "January 2, 2006 at 3:04 PM MST".
const LONG_DATE_TIME: &str = "%B %-d, %Y at %-I:%M %p %Z";

/// Unix seconds as "2006-01-02 15:04:05" in the local zone.
pub fn local_date_time(unix_seconds: i64) -> String {
    match Timestamp::from_second(unix_seconds) {
        Ok(ts) => date_time(&ts.to_zoned(TimeZone::system())),
        Err(_) => unix_seconds.to_string(),
    }
}

/// Unix seconds as RFC 3339 in the local zone.
pub fn local_rfc3339(unix_seconds: i64) -> String {
    match Timestamp::from_second(unix_seconds) {
        Ok(ts) => rfc3339(&ts.to_zoned(TimeZone::system())),
        Err(_) => unix_seconds.to_string(),
    }
}

/// Unix nanoseconds as "January 2, 2006 at 3:04 PM MST" in the local zone.
pub fn local_long_date_time_nanos(unix_nanos: i64) -> String {
    match Timestamp::from_nanosecond(i128::from(unix_nanos)) {
        Ok(ts) => long_date_time(&ts.to_zoned(TimeZone::system())),
        Err(_) => unix_nanos.to_string(),
    }
}

pub fn date_time(zoned: &Zoned) -> String {
    zoned.strftime(DATE_TIME).to_string()
}

/// Go's `time.RFC3339`: whole seconds, and "Z" rather than "+00:00" for a
/// zero offset.
pub fn rfc3339(zoned: &Zoned) -> String {
    if zoned.offset().seconds() == 0 {
        zoned.strftime("%Y-%m-%dT%H:%M:%SZ").to_string()
    } else {
        zoned.strftime("%Y-%m-%dT%H:%M:%S%:z").to_string()
    }
}

pub fn long_date_time(zoned: &Zoned) -> String {
    zoned.strftime(LONG_DATE_TIME).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ts: &str, tz: &str) -> Zoned {
        ts.parse::<Timestamp>().unwrap().to_zoned(TimeZone::get(tz).unwrap())
    }

    #[test]
    fn formats_match_go_layouts() {
        let utc = at("2026-04-03T14:30:05Z", "UTC");
        assert_eq!(date_time(&utc), "2026-04-03 14:30:05");
        assert_eq!(rfc3339(&utc), "2026-04-03T14:30:05Z");
        assert_eq!(long_date_time(&utc), "April 3, 2026 at 2:30 PM UTC");

        let ny = at("2026-01-09T05:04:00Z", "America/New_York");
        assert_eq!(date_time(&ny), "2026-01-09 00:04:00");
        assert_eq!(rfc3339(&ny), "2026-01-09T00:04:00-05:00");
        assert_eq!(long_date_time(&ny), "January 9, 2026 at 12:04 AM EST");
    }

    #[test]
    fn local_helpers_use_system_zone() {
        let ts = Timestamp::from_second(1_775_226_600).unwrap();
        let local = ts.to_zoned(TimeZone::system());
        assert_eq!(local_date_time(1_775_226_600), date_time(&local));
        assert_eq!(local_rfc3339(1_775_226_600), rfc3339(&local));
        assert_eq!(local_long_date_time_nanos(1_775_226_600_000_000_000), long_date_time(&local));
    }
}
