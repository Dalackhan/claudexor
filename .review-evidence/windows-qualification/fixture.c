/* Evidence-only native Windows CLI; no provider, accounts, network, or child processes. */
#include <windows.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--hang") == 0) { Sleep(60000); return 9; }
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("2.1.281 (Windows qualification fixture)"); return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--help") == 0) {
    puts("--tools <tools>\n--setting-sources <sources>\n--strict-mcp-config\n"
         "--permission-mode <mode> (plan, acceptEdits)\n--disable-slash-commands\n--no-chrome\n"
         "--effort <level> Effort level (low, medium, high, max)"); return 0;
  }
  if (argc == 3 && strcmp(argv[1], "auth") == 0 && strcmp(argv[2], "status") == 0) {
    puts("{\"loggedIn\":false,\"authMethod\":\"none\"}"); return 0;
  }
  fputs("unexpected fixture invocation\n", stderr); return 64;
}
