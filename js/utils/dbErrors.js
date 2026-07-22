// Translates raw PostgREST/Postgres errors into short, staff-facing messages.
// Falls back to the server-provided message when we don't recognise the code.
const CODE_MESSAGES = {
  '23P01': 'That date range overlaps an existing one. Adjust the dates and try again.',
  '23505': 'That record already exists.',
  '23514': 'One of the values entered does not meet the required constraints.',
  '23503': 'This record is referenced elsewhere and cannot be changed.'
};

export function friendlyDbError(error, fallback = 'Something went wrong while talking to the database.') {
  if (!error) return new Error(fallback);
  const code = error.code || error?.details?.code;
  const mapped = code && CODE_MESSAGES[code];
  const message = mapped || error.message || fallback;
  const wrapped = new Error(message);
  wrapped.cause = error;
  wrapped.code = code;
  return wrapped;
}
