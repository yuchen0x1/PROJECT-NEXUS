# Release management

Release writes follow this lifecycle:

`draft → checks → confirmation → published`

Draft creation and editing require Operator permission. Publishing requires Administrator permission and an explicit `confirm=true` request. Existing releases cannot be overwritten by a create request with the same tag. Assets are tracked with their source filename, size, digest, and upload result.

The current API uses GitHub Releases as the source of truth. A local draft record is kept in task and audit history so failed operations remain visible.
