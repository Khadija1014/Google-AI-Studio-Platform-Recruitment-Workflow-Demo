import React, { useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from '@google/genai';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';

// Setup PDF.js worker to handle PDF parsing in the background.
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

const App = () => {
  // --- STATE MANAGEMENT ---
  const [jobDescription, setJobDescription] = useState('');
  const [resumeFiles, setResumeFiles] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [emailContent, setEmailContent] = useState('');
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [progress, setProgress] = useState(null);
  
  // --- API INITIALIZATION ---
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // --- HELPER & UTILITY FUNCTIONS ---
  const extractTextFromFile = (file) => {
    return new Promise(async (resolve, reject) => {
      if (file.type === 'application/pdf') {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
          let fullText = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\n\n';
          }
          resolve(fullText.trim());
        } catch (error) {
          console.error('Error parsing PDF:', error);
          reject(new Error('Failed to parse PDF file.'));
        }
      } else if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.name.endsWith('.docx')) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const result = await mammoth.extractRawText({ arrayBuffer });
          resolve(result.value);
        } catch (error) {
          console.error('Error parsing DOCX:', error);
          reject(new Error('Failed to parse DOCX file.'));
        }
      } else if (file.type === 'text/plain') {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = (error) => reject(error);
        reader.readAsText(file);
      } else {
        reject(new Error(`Unsupported file type: ${file.name}. Please upload .txt, .pdf, or .docx files.`));
      }
    });
  };

  // --- CORE AI FUNCTIONS ---

  const parseResume = async (resumeText) => {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Parse the following resume and extract the candidate's name, email, a brief summary of their experience, and a list of their top 5 skills. Here is the resume:\n\n${resumeText}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              email: { type: Type.STRING },
              summary: { type: Type.STRING },
              skills: { 
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
            },
          },
        },
      });
      const parsedJson = JSON.parse(response.text);
      return parsedJson;
    } catch (e) {
      console.error('Error parsing resume:', e);
      throw new Error('Failed to parse resume with AI.');
    }
  };

  const matchCandidate = async (resumeInfo, jd) => {
    try {
      const prompt = `Job Description:\n${jd}\n\nCandidate Skills and Summary:\n${resumeInfo.summary}\nSkills: ${resumeInfo.skills.join(', ')}\n\nBased on the job description, please provide a match score from 0 to 100 for this candidate and a brief (1-2 sentence) justification for your rating.`;
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              score: { type: Type.INTEGER },
              justification: { type: Type.STRING },
            },
          },
        },
      });
      const parsedJson = JSON.parse(response.text);
      return parsedJson;
    } catch(e) {
      console.error('Error matching candidate:', e);
      throw new Error('Failed to match candidate with AI.');
    }
  };

  const generateEmail = async (candidateInfo, jd) => {
    try {
      const prompt = `Draft a friendly and professional outreach email to a candidate named ${candidateInfo.name} for a job. Mention that you were impressed with their experience, particularly their skills in [mention 1-2 key skills from their resume]. The email should include a placeholder [Recruiter's Calendly Link] for them to schedule a meeting. Here is the candidate's info: ${JSON.stringify(candidateInfo)}. And the job description: ${jd}`;
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: prompt
      });
      return response.text;
    } catch(e) {
      console.error('Error generating email:', e);
      throw new Error('Failed to generate email with AI.');
    }
  };

  // --- EVENT HANDLERS ---

  const handleFileChange = (e) => {
    setResumeFiles(Array.from(e.target.files));
  };
  
  const handleFindCandidates = useCallback(async () => {
    if (!jobDescription || resumeFiles.length === 0) {
      setError('Please provide a job description and at least one resume.');
      return;
    }
    setIsLoading(true);
    setError(null);
    setCandidates([]);
    setProgress({ processed: 0, total: resumeFiles.length });

    const BATCH_SIZE = 5; // Process resumes in batches to avoid rate limiting and browser issues.

    try {
      for (let i = 0; i < resumeFiles.length; i += BATCH_SIZE) {
        const batch = resumeFiles.slice(i, i + BATCH_SIZE);
        
        const processingPromises = batch.map(async (file) => {
          try {
            const resumeText = await extractTextFromFile(file);
            const resumeInfo = await parseResume(resumeText);
            const matchResult = await matchCandidate(resumeInfo, jobDescription);
            return {
              id: file.name + Date.now(),
              ...resumeInfo,
              ...matchResult,
              status: 'New'
            };
          } catch (fileError) {
            console.error(`Could not process file ${file.name}:`, fileError);
            return {
              id: file.name + Date.now(),
              name: file.name,
              score: 0,
              justification: `Error: ${fileError.message}`,
              skills: [],
              status: 'Error'
            };
          }
        });
        
        const batchResults = await Promise.all(processingPromises);
        
        // Update candidates and progress incrementally for a better UX
        setCandidates(prev => [...prev, ...batchResults].sort((a, b) => b.score - a.score));
        setProgress(prev => ({ ...prev, processed: prev.processed + batch.length }));
      }

    } catch (e) {
      setError(e.message || 'An unexpected error occurred.');
    } finally {
      setIsLoading(false);
      setProgress(null); // Reset progress indicator
    }
  }, [jobDescription, resumeFiles]);

  const handleGenerateEmail = async (candidate) => {
    setSelectedCandidate(candidate);
    setIsModalOpen(true);
    setEmailContent('Generating email...');
    const email = await generateEmail(candidate, jobDescription);
    setEmailContent(email);
  };

  const handleSendEmail = () => {
    setCandidates(prev => 
      prev.map(c => 
        c.id === selectedCandidate.id ? { ...c, status: 'Contacted' } : c
      )
    );
    setIsModalOpen(false);
    setSelectedCandidate(null);
  };

  // --- RENDER ---
  
  const Styles = {
    // Styles are included here for simplicity in a single-file setup
    global: `
      :root {
        --primary-color: #4A90E2;
        --secondary-color: #F5F7FA;
        --accent-color: #50E3C2;
        --text-color: #333;
        --light-text-color: #777;
        --border-color: #E0E6ED;
        --card-bg: #FFFFFF;
        --shadow: 0 4px 6px rgba(0,0,0,0.1);
      }
      body {
        font-family: 'Inter', sans-serif;
        background-color: var(--secondary-color);
        color: var(--text-color);
        margin: 0;
        padding: 2rem;
      }
    `,
    main: {
      maxWidth: '1200px',
      margin: '0 auto',
      display: 'grid',
      gridTemplateColumns: '1fr 2fr',
      gap: '2rem',
      '@media (max-width: 900px)': {
        gridTemplateColumns: '1fr',
      }
    },
    header: {
      gridColumn: '1 / -1',
      textAlign: 'center',
      marginBottom: '1rem',
    },
    title: {
      fontSize: '2.5rem',
      color: 'var(--primary-color)',
      fontWeight: 700,
    },
    inputPanel: {
      background: 'var(--card-bg)',
      padding: '1.5rem',
      borderRadius: '8px',
      boxShadow: 'var(--shadow)',
      display: 'flex',
      flexDirection: 'column',
      gap: '1.5rem',
    },
    label: {
      fontSize: '1rem',
      fontWeight: '600',
      marginBottom: '0.5rem',
      display: 'block',
    },
    textarea: {
      width: '100%',
      minHeight: '200px',
      border: '1px solid var(--border-color)',
      borderRadius: '4px',
      padding: '0.75rem',
      fontSize: '0.9rem',
      resize: 'vertical',
    },
    fileInput: {
      border: '2px dashed var(--border-color)',
      borderRadius: '4px',
      padding: '2rem',
      textAlign: 'center',
      cursor: 'pointer',
      transition: 'background-color 0.2s',
    },
    button: {
      backgroundColor: 'var(--primary-color)',
      color: 'white',
      border: 'none',
      padding: '0.75rem 1.5rem',
      borderRadius: '4px',
      fontSize: '1rem',
      fontWeight: '600',
      cursor: 'pointer',
      transition: 'background-color 0.2s',
      width: '100%',
      opacity: (isLoading || !jobDescription || resumeFiles.length === 0) ? 0.6 : 1,
    },
    resultsPanel: {
       minHeight: '400px',
    },
    candidateCard: {
      background: 'var(--card-bg)',
      borderRadius: '8px',
      boxShadow: 'var(--shadow)',
      padding: '1.5rem',
      marginBottom: '1rem',
      display: 'flex',
      gap: '1.5rem',
      alignItems: 'flex-start',
    },
    scoreCircle: (score) => ({
        width: '70px',
        height: '70px',
        borderRadius: '50%',
        background: `radial-gradient(closest-side, white 79%, transparent 80% 100%), conic-gradient(var(--accent-color) ${score}%, var(--border-color) 0)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '1.5rem',
        fontWeight: '700',
        flexShrink: 0,
    }),
    cardContent: {
      flexGrow: 1,
    },
    candidateName: {
      margin: '0 0 0.5rem 0',
      fontSize: '1.25rem',
      fontWeight: '600',
    },
    justification: {
      fontStyle: 'italic',
      color: 'var(--light-text-color)',
      margin: '0 0 1rem 0',
      fontSize: '0.9rem',
    },
    skillsContainer: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '0.5rem',
      marginTop: '1rem',
    },
    skillTag: {
      background: 'var(--secondary-color)',
      color: 'var(--primary-color)',
      padding: '0.25rem 0.75rem',
      borderRadius: '12px',
      fontSize: '0.8rem',
      fontWeight: '500',
    },
    cardActions: {
      display: 'flex',
      flexDirection: 'column',
      gap: '0.5rem',
      alignItems: 'center',
    },
    emailButton: {
       background: 'transparent',
       border: `1px solid var(--primary-color)`,
       color: 'var(--primary-color)',
       padding: '0.5rem 1rem',
       cursor: 'pointer',
       borderRadius: '4px',
       transition: 'background-color 0.2s',
    },
    statusBadge: (status) => ({
      padding: '0.25rem 0.75rem',
      borderRadius: '12px',
      fontSize: '0.8rem',
      fontWeight: '500',
      textAlign: 'center',
      marginTop: '0.5rem',
      color: status === 'Contacted' ? '#006400' : status === 'Error' ? '#8B0000' : 'var(--light-text-color)',
      backgroundColor: status === 'Contacted' ? '#90EE90' : status === 'Error' ? '#F08080' : 'var(--border-color)',
    }),
    loader: {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      height: '100%',
      fontSize: '1.2rem',
      color: 'var(--light-text-color)'
    },
    modalOverlay: {
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    modalContent: {
      background: 'white',
      padding: '2rem',
      borderRadius: '8px',
      maxWidth: '600px',
      width: '90%',
    },
    modalEmail: {
      whiteSpace: 'pre-wrap',
      background: '#f9f9f9',
      padding: '1rem',
      borderRadius: '4px',
      maxHeight: '400px',
      overflowY: 'auto',
      border: '1px solid #eee',
    },
    modalActions: {
        marginTop: '1rem',
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '1rem',
    }
  };

  return (
    <>
      <style>{Styles.global}</style>
      <header style={Styles.header}>
        <h1 style={Styles.title}>AI Recruitment Hub</h1>
      </header>
      <main style={Styles.main}>
        <div style={Styles.inputPanel}>
          <div>
            <label htmlFor="job-description" style={Styles.label}>1. Paste Job Description</label>
            <textarea
              id="job-description"
              style={Styles.textarea}
              placeholder="e.g., Senior Frontend Engineer with React experience..."
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="resume-upload" style={Styles.label}>2. Upload Resumes</label>
            <label htmlFor="resume-upload" style={Styles.fileInput}>
              {resumeFiles.length > 0 ? `${resumeFiles.length} file(s) selected` : 'Click to select files (.txt, .pdf, .docx)'}
            </label>
            <input
              id="resume-upload"
              type="file"
              multiple
              accept=".txt,.pdf,.docx"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
          <button 
            style={Styles.button}
            onClick={handleFindCandidates} 
            disabled={isLoading || !jobDescription || resumeFiles.length === 0}>
            {isLoading && progress ? `Processing... (${progress.processed}/${progress.total})` : '3. Find Candidates'}
          </button>
          {error && <p style={{ color: 'red' }}>{error}</p>}
        </div>
        <div style={Styles.resultsPanel}>
          {isLoading && progress && <div style={Styles.loader}>Analyzing candidates... {progress.processed} of {progress.total} complete.</div>}
          {!isLoading && candidates.length === 0 && (
             <div style={Styles.loader}>
                Matched candidates will appear here.
             </div>
          )}
          {candidates.map(candidate => (
            <div key={candidate.id} style={Styles.candidateCard}>
              <div style={Styles.scoreCircle(candidate.score)}>
                {candidate.status === 'Error' ? '!' : `${candidate.score}`}
              </div>
              <div style={Styles.cardContent}>
                <h3 style={Styles.candidateName}>{candidate.name}</h3>
                <p style={Styles.justification}>{candidate.justification}</p>
                 {candidate.skills && candidate.skills.length > 0 && (
                    <div style={Styles.skillsContainer}>
                      {candidate.skills.slice(0,5).map(skill => <span key={skill} style={Styles.skillTag}>{skill}</span>)}
                    </div>
                 )}
              </div>
              <div style={Styles.cardActions}>
                 <button 
                    style={Styles.emailButton}
                    onClick={() => handleGenerateEmail(candidate)}
                    disabled={candidate.status === 'Error'}
                    >
                    Generate Email
                 </button>
                 <span style={Styles.statusBadge(candidate.status)}>{candidate.status}</span>
              </div>
            </div>
          ))}
        </div>
      </main>
      {isModalOpen && (
        <div style={Styles.modalOverlay}>
            <div style={Styles.modalContent}>
                <h2>Email to {selectedCandidate?.name}</h2>
                <div style={Styles.modalEmail}>
                    {emailContent}
                </div>
                <div style={Styles.modalActions}>
                    <button style={{...Styles.emailButton, borderColor: '#ccc', color: '#333'}} onClick={() => setIsModalOpen(false)}>Cancel</button>
                    <button style={{...Styles.button, width: 'auto'}} onClick={handleSendEmail}>Mark as Sent</button>
                </div>
            </div>
        </div>
      )}
    </>
  );
};

const root = createRoot(document.getElementById('root'));
root.render(<App />);