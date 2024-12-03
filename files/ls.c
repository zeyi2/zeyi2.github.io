#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <dirent.h>
#include <pwd.h>
#include <grp.h>
#include <time.h>
#include <getopt.h>

#define MAX_PATH 1024
#define OMIT(x) ((x >> 2) & 1)
#define FORMAT(x) ((x >> 1) & 1)
#define RECURSIVE(x) (x & 1)

char permission[] = "rwxrwxrwx";
mode_t modes[] = {S_IRUSR,S_IWUSR,S_IXUSR,
                  S_IRGRP,S_IWGRP,S_IXGRP,
		  S_IROTH,S_IWOTH,S_IXOTH};

void print_help();
void simple_format(char* name);
void long_format(char* name);
void list_file(char* dirname, int opcode);

void simple_format(char* name)
{
    printf(" %s\n", name);
}

void long_format(char* name)
{
    struct stat stbuf;
    
    if (stat(name, &stbuf) == -1)
    {
	fprintf(stderr, "ls: can't access %s\n", name);
	return;
    }
    
    printf((S_ISDIR(stbuf.st_mode)) ? "d" : "-");
    for (int i = 0; i < 9; i++)
	printf((stbuf.st_mode & modes[i]) ? "%c" : "-", permission[i]);

    printf(" %ld", stbuf.st_nlink);
    struct passwd *pw = getpwuid(stbuf.st_uid);
    struct group *gr = getgrgid(stbuf.st_gid);
    printf(" %s %s", pw ? pw->pw_name : "unknown", gr ? gr->gr_name : "unknown");

    printf(" %8ld", stbuf.st_size);

    char timebuf[64];
    struct tm *tm = localtime(&stbuf.st_mtime);
    strftime(timebuf, sizeof(timebuf), "%b %d %H:%M", tm);
    printf(" %s", timebuf);

    printf(" %s\n", name);
}

void list_file(char* dir_name, int opcode)
{
    DIR *d;
    struct dirent *dir;
    
    int omitted = OMIT(opcode);
    int format = FORMAT(opcode);
    int recursive = RECURSIVE(opcode);
    
    char* dirname = (strncmp(dir_name, "~", 1) == 0)
	? (getenv("HOME"))
	: (dir_name);
    
    d = opendir(dirname);
    
    if (d == NULL)
    {
	fprintf(stderr, "ls: %s not found\n", dirname);
	return;
    }
    
    while ((dir = readdir(d)) != NULL)
    {
	if (strcmp(dir->d_name, ".") == 0 || strcmp(dir->d_name, "..") == 0)
	{
	    continue;
	}
	
        if (!omitted && dir->d_name[0] == '.')
	{
	    continue;
	}
	
	char path[MAX_PATH];
	(dirname[strlen(dirname) - 1] == '/')
	    ? snprintf(path, sizeof(path), "%s%s", dirname, dir->d_name)
	    : snprintf(path, sizeof(path), "%s/%s", dirname, dir->d_name);
	
	format ? long_format(path) : simple_format(path);

	if (dir->d_type == DT_DIR && recursive)
	{
	    list_file(path, opcode);
	}
    }
}

void print_help()
{
    printf("Usage: ls [OPTIONS] <dir>\n");
    printf("OPTIONS:\n");
    printf("    -l, --long\n");
    printf("    -R, --recursive\n");
    printf("    -a, --all\n");
    printf("    -h, --help\n");
}

int main(int argc, char *argv[])
{
    static int recursive = 0;
    static int format = 0;
    static int omitted = 0;
    int opt;

    static struct option long_options[] =
	{
	    { "help", no_argument, NULL, 'h'},
	    { "all", optional_argument, NULL, 'a'},
	    { "long", optional_argument, NULL, 'l'},
	    { "recursive", optional_argument, NULL , 'R'},
	    { 0, 0, 0, 0}
	};

    while ((opt = getopt_long(argc, argv, "halR", long_options, NULL)) != -1)
    {
	switch (opt)
	{
	case 'h':
	    print_help();
	    exit(EXIT_SUCCESS);
	case 'a':
	    omitted = 1;
	    break;
	case 'l':
	    format = 1;
	    break;
	case 'R':
	    recursive = 1;
	    break;
	case '?':
	    fprintf(stderr, "ls: unknown option\n");
	    print_help();
	    exit(EXIT_FAILURE);
	}
    }

    int opcode = ((omitted) << 2) | ((format) << 1) | (recursive);

    if (optind == argc)
    {
	list_file(".", opcode);
    }
    else if (optind + 1 == argc)
    {
	list_file(argv[optind], opcode);
    }
    else
    {
	int i = optind;
	
	while (i < argc)
	{
	    printf("Files in %s:\n", argv[i]);
	    list_file(argv[i], opcode);
	    printf("\n");
	    i++;
	}
    }

    return 0;
}
