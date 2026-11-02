export const sendSuccess = (res, data, { status = 200, message, meta } = {}) => {
  res.status(status).json({
    success: true,
    ...(message && { message }),
    data,
    ...(meta && { meta }),
  });
};

export const sendError = (res, status, message, errors) => {
  res.status(status).json({
    success: false,
    message,
    ...(errors && { errors }),
  });
};
