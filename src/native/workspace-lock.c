#include <errno.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <unistd.h>
#include <string.h>

/*
 * flock is associated with the inherited open file description. The host
 * keeps its own descriptor, and each SVN process inherits the same lock.
 */
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (strcmp(argv[1], "acquire") == 0) {
    for (int i = 2; i < argc; ++i) {
      int mode = argv[i][0] == 'x' ? LOCK_EX : LOCK_SH;
      if (flock(i + 1, mode | LOCK_NB) == -1)
        return errno == EWOULDBLOCK ? 1 : 2;
    }
    return 0;
  }

  if (strcmp(argv[1], "run") != 0 || argc < 3) return 2;
  pid_t child = fork();
  if (child < 0) return 126;
  if (child == 0) {
    execvp(argv[2], &argv[2]);
    return errno == ENOENT ? 127 : 126;
  }
  int status;
  while (waitpid(child, &status, 0) == -1) {
    if (errno != EINTR) return 126;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 126;
}
