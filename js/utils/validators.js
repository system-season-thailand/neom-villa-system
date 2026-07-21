export function validateGuestName(value) {
  if (!value || !value.trim()) return 'Guest name is required.';
  if (value.trim().length > 120) return 'Guest name is too long.';
  return null;
}

export function validateCheckIn(value) {
  if (!value) return 'Check-in date is required.';
  return null;
}

export function validateNights(value) {
  const n = Number(value);
  if (!value && value !== 0) return 'Number of nights is required.';
  if (!Number.isInteger(n) || n <= 0) return 'Nights must be a positive whole number.';
  if (n > 730) return 'Nights must be less than 730.';
  return null;
}

export function validateVillaType(value) {
  if (!value) return 'Villa type is required.';
  return null;
}

export function validatePriceRange(startDate, endDate) {
  if (!startDate || !endDate) return 'Start and end dates are required.';
  if (endDate < startDate) return 'End date must be on or after the start date.';
  return null;
}

export function validatePricePerNight(value) {
  const n = Number(value);
  if (!value && value !== 0) return 'Price per night is required.';
  if (Number.isNaN(n) || n <= 0) return 'Price per night must be a positive number.';
  return null;
}
