package cli

import (
	"fmt"
	"strconv"
)

func parsePositiveInt64(raw string, field string) (int64, error) {
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("%s must be a positive integer, got %q", field, raw)
	}

	return value, nil
}
