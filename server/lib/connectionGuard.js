// A saved password that can no longer be decrypted (data folder copied to another computer, OS
// credential store reset, …) must never be sent as an empty password: that would fail as a confusing
// "authentication failed" and, against some directories, count towards an account lockout.
function assertPasswordUsable(connection) {
  if (connection && connection.passwordUnreadable) {
    const err = new Error(
      `The saved password for "${connection.name || 'this connection'}" can't be read on this computer any more. ` +
      'Open Connections and enter it again.'
    );
    err.status = 409;
    err.code = 'PASSWORD_UNREADABLE';
    throw err;
  }
}

module.exports = { assertPasswordUsable };
