import sys
regs={}; 
for line in sys.stdin:
    p=line.split()
    if len(p)==2 and p[0].isdigit(): regs[int(p[0])]=int(p[1])
    elif line.startswith('begin'): print(line.strip())
def dec(base):
    r=[regs.get(base+i,0) for i in range(8)]
    p3=((r[5]>>4)&0xF)<<16|r[0]<<8|r[1]; p1=(r[2]&3)<<16|r[3]<<8|r[4]; p2=(r[5]&0xF)<<16|r[6]<<8|r[7]
    return (p1+512+p2/p3)/128
x=25e6
srcB = (regs.get(17,0)>>5)&1; srcA=(regs.get(16,0)>>5)&1
pllA=dec(26); pllB=dec(34) if any(regs.get(34+i) for i in range(8)) else pllA
v0=x*(pllB if srcA else pllA); v1=x*(pllB if srcB else pllA)
f0=v0/dec(42); f1=v1/dec(50)
print("CLK0 %.4f Hz | CLK1 %.4f Hz | offset %.6f Hz | expansion %.1fx"%(f0,f1,f0-f1,f0/(f0-f1)))
print("CLK0_CTRL 0x%02X  CLK1_CTRL 0x%02X  OUT_EN(reg3) 0x%02X"%(regs.get(16,0),regs.get(17,0),regs.get(3,0)))
